// Local launcher: `npm start` runs this directly with plain Node, no
// Netlify CLI required. Same app.js also runs as a Netlify Function when
// deployed (see netlify/functions/api.js) -- only the datastore backend
// switches (JSON file here, Netlify Blobs there); everything else in the
// app is identical.

const app = require("./lib/app");

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`SDR Outreach running at http://localhost:${PORT}`);
});
