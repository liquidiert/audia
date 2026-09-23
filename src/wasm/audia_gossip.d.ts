/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

/**
 * A running iroh endpoint with the gossip protocol mounted.
 */
export class AudiaNode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Teach the endpoint how to reach a peer via a relay, so bootstrap does not
     * depend on DNS/pkarr address lookup.
     */
    addPeer(endpoint_id: string, relay_url?: string | null): void;
    /**
     * Shut the endpoint down.
     */
    close(): Promise<void>;
    /**
     * This endpoint's id (public key string).
     */
    endpointId(): string;
    /**
     * Subscribe to a topic (32 bytes). `on_event` receives objects shaped like
     * `{type: "received", content: Uint8Array, from: string}`,
     * `{type: "neighborUp" | "neighborDown", peer: string}`, `{type: "lagged"}`
     * or `{type: "closed", error?: string}`.
     */
    join(topic: Uint8Array, bootstrap: string[], on_event: Function): Promise<Channel>;
    /**
     * Resolves once a home relay is connected. Returns its URL, if any.
     */
    online(): Promise<string | undefined>;
    /**
     * Current home relay URL (may be empty before `online` resolves).
     */
    relayUrl(): string | undefined;
    /**
     * The 32 secret key bytes, for persisting identity.
     */
    secretKey(): Uint8Array;
    /**
     * Sign `data` with this endpoint's ed25519 key (64-byte signature).
     */
    sign(data: Uint8Array): Uint8Array;
    /**
     * Bind a new endpoint. Pass a previously stored 32-byte secret key to keep
     * a stable identity across reloads, or `undefined` to generate one.
     */
    static spawn(secret_key?: Uint8Array | null): Promise<AudiaNode>;
}

/**
 * Sending half of a topic subscription.
 */
export class Channel {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Broadcast only to direct neighbors.
     */
    broadcastNeighbors(data: Uint8Array): Promise<void>;
    /**
     * Broadcast to the whole swarm.
     */
    broadcast(data: Uint8Array): Promise<void>;
    /**
     * Ask the swarm layer to connect to more peers.
     */
    joinPeers(peers: string[]): Promise<void>;
}

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

export function start(): void;

/**
 * Verify an ed25519 `signature` over `data` made by `endpoint_id`.
 */
export function verify(endpoint_id: string, data: Uint8Array, signature: Uint8Array): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_audianode_free: (a: number, b: number) => void;
    readonly __wbg_channel_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly audianode_addPeer: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly audianode_close: (a: number) => any;
    readonly audianode_endpointId: (a: number) => [number, number];
    readonly audianode_join: (a: number, b: number, c: number, d: number, e: number, f: any) => any;
    readonly audianode_online: (a: number) => any;
    readonly audianode_relayUrl: (a: number) => [number, number];
    readonly audianode_secretKey: (a: number) => [number, number];
    readonly audianode_sign: (a: number, b: number, c: number) => [number, number];
    readonly audianode_spawn: (a: number, b: number) => any;
    readonly channel_broadcast: (a: number, b: number, c: number) => any;
    readonly channel_broadcastNeighbors: (a: number, b: number, c: number) => any;
    readonly channel_joinPeers: (a: number, b: number, c: number) => any;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
    readonly intounderlyingbytesource_start: (a: number, b: any) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: any) => any;
    readonly intounderlyingsink_close: (a: number) => any;
    readonly intounderlyingsink_write: (a: number, b: any) => any;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: any) => any;
    readonly start: () => void;
    readonly verify: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasm_bindgen_ea3a7c072977745f___convert__closures_____invoke___js_sys_910e91bad28f87b8___Function_fn_wasm_bindgen_ea3a7c072977745f___JsValue_____wasm_bindgen_ea3a7c072977745f___sys__Undefined___js_sys_910e91bad28f87b8___Function_fn_wasm_bindgen_ea3a7c072977745f___JsValue_____wasm_bindgen_ea3a7c072977745f___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_ea3a7c072977745f___convert__closures_____invoke___wasm_bindgen_ea3a7c072977745f___JsValue__core_7d5f0a2ba6a62c33___result__Result_____wasm_bindgen_ea3a7c072977745f___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_ea3a7c072977745f___convert__closures_____invoke___wasm_bindgen_ea3a7c072977745f___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_ea3a7c072977745f___convert__closures_____invoke___web_sys_6ebf99d6397dfc5a___features__gen_CloseEvent__CloseEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_ea3a7c072977745f___convert__closures_____invoke___web_sys_6ebf99d6397dfc5a___features__gen_MessageEvent__MessageEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_ea3a7c072977745f___convert__closures_____invoke_______true_: (a: number, b: number) => void;
    readonly wasm_bindgen_ea3a7c072977745f___convert__closures_____invoke_______true__1_: (a: number, b: number) => void;
    readonly wasm_bindgen_ea3a7c072977745f___convert__closures_____invoke_______true__2_: (a: number, b: number) => void;
    readonly wasm_bindgen_ea3a7c072977745f___convert__closures_____invoke_______true__3_: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
