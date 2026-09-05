// Wraps the same Express app used locally (lib/app.js) so it can run as a
// Netlify Function. netlify.toml routes /api/* here; the datastore
// automatically switches to Netlify Blobs because process.env.NETLIFY is
// set in this environment (see lib/store.js).

const serverless = require("serverless-http");
const app = require("../../lib/app");

module.exports.handler = serverless(app);
