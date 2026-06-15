const fs = require("fs")
const path = require("path")

// Load .env (written by bin/services up) so the macro suite reaches this checkout's services.
const envPath = path.join(__dirname, "..", ".env")

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const entry = line.trim()
    if (!entry || entry.startsWith("#") || !entry.includes("=")) continue
    const separator = entry.indexOf("=")
    const key = entry.slice(0, separator).trim()
    const value = entry.slice(separator + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
}
