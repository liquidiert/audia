//! Thin wasm-bindgen wrapper around iroh + iroh-gossip for use in the browser.
//!
//! Browsers cannot open raw UDP sockets, so all traffic flows through iroh relays.
//! The JS side only sees opaque byte payloads; all app logic lives in TypeScript.

use std::str::FromStr;

use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayUrl, SecretKey, Signature,
    address_lookup::memory::MemoryLookup, endpoint::presets, protocol::Router,
};
use iroh_gossip::{
    ALPN as GOSSIP_ALPN,
    api::{Event, GossipSender},
    net::Gossip,
    proto::TopicId,
};
use js_sys::{Function, Object, Reflect, Uint8Array};
use n0_future::StreamExt;
use wasm_bindgen::prelude::*;

/// Max gossip payload. Every peer in a session runs this same build, so they agree.
const MAX_MESSAGE_SIZE: usize = 32 * 1024;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// A running iroh endpoint with the gossip protocol mounted.
#[wasm_bindgen]
pub struct AudiaNode {
    endpoint: Endpoint,
    gossip: Gossip,
    lookup: MemoryLookup,
    _router: Router,
}

#[wasm_bindgen]
impl AudiaNode {
    /// Bind a new endpoint. Pass a previously stored 32-byte secret key to keep
    /// a stable identity across reloads, or `undefined` to generate one.
    pub async fn spawn(secret_key: Option<Vec<u8>>) -> Result<AudiaNode, JsError> {
        let secret_key = match secret_key {
            Some(bytes) => {
                let bytes: [u8; 32] = bytes
                    .try_into()
                    .map_err(|_| js_err("secret key must be 32 bytes"))?;
                SecretKey::from_bytes(&bytes)
            }
            None => SecretKey::generate(),
        };
        let lookup = MemoryLookup::new();
        let endpoint = Endpoint::builder(presets::N0)
            .secret_key(secret_key)
            .address_lookup(lookup.clone())
            .bind()
            .await
            .map_err(js_err)?;
        let gossip = Gossip::builder()
            .max_message_size(MAX_MESSAGE_SIZE)
            .spawn(endpoint.clone());
        let router = Router::builder(endpoint.clone())
            .accept(GOSSIP_ALPN, gossip.clone())
            .spawn();
        Ok(AudiaNode {
            endpoint,
            gossip,
            lookup,
            _router: router,
        })
    }

    /// This endpoint's id (public key string).
    #[wasm_bindgen(js_name = endpointId)]
    pub fn endpoint_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// The 32 secret key bytes, for persisting identity.
    #[wasm_bindgen(js_name = secretKey)]
    pub fn secret_key(&self) -> Vec<u8> {
        self.endpoint.secret_key().to_bytes().to_vec()
    }

    /// Sign `data` with this endpoint's ed25519 key (64-byte signature).
    pub fn sign(&self, data: &[u8]) -> Vec<u8> {
        self.endpoint.secret_key().sign(data).to_bytes().to_vec()
    }

    /// Resolves once a home relay is connected. Returns its URL, if any.
    pub async fn online(&self) -> Option<String> {
        self.endpoint.online().await;
        self.endpoint
            .addr()
            .relay_urls()
            .next()
            .map(|u| u.to_string())
    }

    /// Current home relay URL (may be empty before `online` resolves).
    #[wasm_bindgen(js_name = relayUrl)]
    pub fn relay_url(&self) -> Option<String> {
        self.endpoint
            .addr()
            .relay_urls()
            .next()
            .map(|u| u.to_string())
    }

    /// Teach the endpoint how to reach a peer via a relay, so bootstrap does not
    /// depend on DNS/pkarr address lookup.
    #[wasm_bindgen(js_name = addPeer)]
    pub fn add_peer(&self, endpoint_id: String, relay_url: Option<String>) -> Result<(), JsError> {
        let id = EndpointId::from_str(&endpoint_id).map_err(js_err)?;
        let mut addr = EndpointAddr::new(id);
        if let Some(url) = relay_url {
            addr = addr.with_relay_url(RelayUrl::from_str(&url).map_err(js_err)?);
        }
        self.lookup.add_endpoint_info(addr);
        Ok(())
    }

    /// Subscribe to a topic (32 bytes). `on_event` receives objects shaped like
    /// `{type: "received", content: Uint8Array, from: string}`,
    /// `{type: "neighborUp" | "neighborDown", peer: string}`, `{type: "lagged"}`
    /// or `{type: "closed", error?: string}`.
    pub async fn join(
        &self,
        topic: Vec<u8>,
        bootstrap: Vec<String>,
        on_event: Function,
    ) -> Result<Channel, JsError> {
        let topic: [u8; 32] = topic
            .try_into()
            .map_err(|_| js_err("topic must be 32 bytes"))?;
        let bootstrap = bootstrap
            .iter()
            .map(|s| EndpointId::from_str(s))
            .collect::<Result<Vec<_>, _>>()
            .map_err(js_err)?;
        let (sender, mut receiver) = self
            .gossip
            .subscribe(TopicId::from_bytes(topic), bootstrap)
            .await
            .map_err(js_err)?
            .split();

        wasm_bindgen_futures::spawn_local(async move {
            loop {
                let obj = Object::new();
                match receiver.next().await {
                    Some(Ok(Event::Received(msg))) => {
                        set(&obj, "type", &"received".into());
                        set(&obj, "content", &Uint8Array::from(&msg.content[..]).into());
                        set(&obj, "from", &msg.delivered_from.to_string().into());
                    }
                    Some(Ok(Event::NeighborUp(peer))) => {
                        set(&obj, "type", &"neighborUp".into());
                        set(&obj, "peer", &peer.to_string().into());
                    }
                    Some(Ok(Event::NeighborDown(peer))) => {
                        set(&obj, "type", &"neighborDown".into());
                        set(&obj, "peer", &peer.to_string().into());
                    }
                    Some(Ok(Event::Lagged)) => set(&obj, "type", &"lagged".into()),
                    Some(Err(e)) => {
                        set(&obj, "type", &"closed".into());
                        set(&obj, "error", &e.to_string().into());
                        let _ = on_event.call1(&JsValue::NULL, &obj);
                        break;
                    }
                    None => {
                        set(&obj, "type", &"closed".into());
                        let _ = on_event.call1(&JsValue::NULL, &obj);
                        break;
                    }
                }
                let _ = on_event.call1(&JsValue::NULL, &obj);
            }
        });

        Ok(Channel { sender })
    }

    /// Shut the endpoint down.
    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

/// Verify an ed25519 `signature` over `data` made by `endpoint_id`.
#[wasm_bindgen]
pub fn verify(endpoint_id: &str, data: &[u8], signature: &[u8]) -> bool {
    let Ok(id) = EndpointId::from_str(endpoint_id) else {
        return false;
    };
    let Ok(sig) = <[u8; 64]>::try_from(signature) else {
        return false;
    };
    id.verify(data, &Signature::from_bytes(&sig)).is_ok()
}

fn set(obj: &Object, key: &str, value: &JsValue) {
    let _ = Reflect::set(obj, &key.into(), value);
}

/// Sending half of a topic subscription.
#[wasm_bindgen]
pub struct Channel {
    sender: GossipSender,
}

#[wasm_bindgen]
impl Channel {
    /// Broadcast to the whole swarm.
    pub async fn broadcast(&self, data: Vec<u8>) -> Result<(), JsError> {
        self.sender.broadcast(data.into()).await.map_err(js_err)
    }

    /// Broadcast only to direct neighbors.
    #[wasm_bindgen(js_name = broadcastNeighbors)]
    pub async fn broadcast_neighbors(&self, data: Vec<u8>) -> Result<(), JsError> {
        self.sender
            .broadcast_neighbors(data.into())
            .await
            .map_err(js_err)
    }

    /// Ask the swarm layer to connect to more peers.
    #[wasm_bindgen(js_name = joinPeers)]
    pub async fn join_peers(&self, peers: Vec<String>) -> Result<(), JsError> {
        let peers = peers
            .iter()
            .map(|s| EndpointId::from_str(s))
            .collect::<Result<Vec<_>, _>>()
            .map_err(js_err)?;
        self.sender.join_peers(peers).await.map_err(js_err)
    }
}
