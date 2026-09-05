const store = require("./store");

async function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const user = await store.find("users", req.session.userId);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Not permitted" });
    }
    next();
  };
}

// Gates a whole feature/tab (Leads, Activity Report, Emailing, LinkedIn
// Search, Salesforce, Accounts Gem) behind the per-user feature_access
// object an admin sets in Settings > Access Control. Admin always passes.
// A user with no feature_access set at all (every account created before
// this existed) also passes -- the toggle is opt-out, not opt-in, so
// nobody's access silently changes until an admin deliberately turns
// something off for them.
function requireFeature(key) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (req.user.role === "admin") return next();
    const access = req.user.feature_access;
    if (access && access[key] === false) {
      return res.status(403).json({ error: "This feature isn't enabled for your account. Ask an admin." });
    }
    next();
  };
}

function publicUser(user) {
  if (!user) return null;
  const { password, ...rest } = user;
  return rest;
}

module.exports = { requireLogin, requireRole, requireFeature, publicUser };
