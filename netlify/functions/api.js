// Wraps the same Express app used locally (lib/app.js) so it can run as a
// Netlify Function. netlify.toml routes /api/* here; the datastore
// automatically switches to Netlify Blobs because process.env.NETLIFY is
// set in this environment (see lib/store.js).

const serverless = require("serverless-http");
const app = require("../../lib/app");

// Netlify Functions run on an AWS Lambda proxy underneath -- any binary
// response body (the .xlsx exports from POST /api/export/xlsx, and any
// future PDF/image download) has to be base64-encoded with
// isBase64Encoded:true, or API Gateway forwards it as if it were UTF-8
// text and mangles whatever byte sequences don't happen to be valid UTF-8.
// serverless-http only does that encoding for content-types listed here;
// without it, the exact same code path that works locally (plain
// node server.js, no Lambda proxy in between) produces a corrupted file
// once deployed. The "*" wildcards are expanded to a regex internally.
module.exports.handler = serverless(app, {
  binary: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/pdf",
    "application/octet-stream",
    "image/*",
  ],
});
