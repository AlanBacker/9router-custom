'use strict';
const path=require('node:path'),os=require('node:os');
process.env.NINEROUTER_APP_ROOT=path.resolve(__dirname,'../..');
process.env.DATA_DIR=process.env.DATA_DIR||path.join(os.homedir(),'.9router');
process.env.NINEROUTER_THINKING_COMPAT='1';
process.env.NINEROUTER_OPENCODE_ANONYMOUS='1';
process.env.NINEROUTER_OPENCODE_PUBLIC_PROXY='1';
require('./thinking-compat.cjs');
// Upstream free-tier inference is gated on the Bun TLS fingerprint; start the
// co-located Bun relay before the fetch wrappers so it can be used as soon as
// the port is up (asynchronous, fail-open when Bun is absent).
require('./opencode-bun-relay.cjs').startBunRelay();
require('./opencode-anonymous.cjs');
require('./opencode-public-proxy.cjs');
