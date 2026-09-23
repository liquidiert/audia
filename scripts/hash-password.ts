#!/usr/bin/env bun
/**
 * Prints a DISPLAY_PASSWORD_HASH value: a salted argon2id hash of the password,
 * base64-encoded so the `$` characters survive .env files and deploy dashboards.
 *
 *   bun run hash-password            # prompts
 *   bun run hash-password 'secret'   # from argv (ends up in shell history)
 */
const password = process.argv[2] ?? prompt("Display password:");
if (!password) {
  console.error("No password given.");
  process.exit(1);
}
const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
console.log(`DISPLAY_PASSWORD_HASH=${Buffer.from(hash).toString("base64")}`);
