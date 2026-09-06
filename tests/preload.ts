// Unit tests import server modules directly; config refuses to load without a real
// session secret unless dev mode is on. The e2e suite spawns its own servers with
// explicit env and is unaffected.
process.env.WORLDS_DEV ??= "1";
