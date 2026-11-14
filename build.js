import fs from "fs";
import { execSync } from "child_process";

const REALM = process.argv.includes("--realm");
const GEN_ONLY = process.argv.includes("--gen-only");

const versionFile = "./src/version.ts";
const configFile = "./config.json";
const generatedConfigFile = "./src/generated/config.ts";
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
fs.mkdirSync("./src/generated", { recursive: true });

fs.writeFileSync(
    generatedConfigFile,
    `export const BackendConfig = ${JSON.stringify({
        serverUrl: config.serverUrl ?? "https://sculwave.com",
        activationKey: config.activationKey ?? "",
        serverName: config.serverName ?? "Bedrock Server",
        platform: config.platform ?? "bedrock",
        pluginVersion: config.pluginVersion ?? "1.1.0",
        minecraftVersion: config.minecraftVersion ?? "1.26.60.6",
        entryPoint: config.entryPoint ?? "bedrock",
        entryPointPriority: config.entryPointPriority ?? 0,
        realmBridgeGamertag: config.realmBridgeGamertag ?? "",
    }, null, 4)} as const;\n`
);

// Transport selection: direct = BDS (server-net), realm = bridge bot (no server-net).
fs.writeFileSync(
    "./src/generated/transport.ts",
    `export * from "../transport/${REALM ? "realm" : "direct"}";\n`
);
if (GEN_ONLY) process.exit(0);



// ---------------------
// Build timestamp
// ---------------------

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");

const timestamp =
    `${String(now.getFullYear()).slice(-2)}` +
    `${pad(now.getMonth() + 1)}` +
    `${pad(now.getDate())}.` +
    `${pad(now.getHours())}` +
    `${pad(now.getMinutes())}`;

let version = fs.readFileSync(versionFile, "utf8");

version = version.replace(
    /build:\s*["'][^"']+["']/,
    `build: "${timestamp}"`
);

fs.writeFileSync(versionFile, version);


// ---------------------
// Compile
// ---------------------

try {

    execSync("npx tsc", {
        stdio: "inherit"
    });

}
catch {

    process.exit(1);

}

// ---------------------
// Realm package (--realm): BP without server-net + RP, zipped as .mcaddon
// ---------------------

if (REALM) {
    const out = "./dist/realm";
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(`${out}/BP/scripts`, { recursive: true });
    fs.cpSync("./build", `${out}/BP/scripts`, { recursive: true });
    for (const f of ["items", "pack_icon.png"]) {
        if (fs.existsSync(`./BP/${f}`)) fs.cpSync(`./BP/${f}`, `${out}/BP/${f}`, { recursive: true });
    }
    fs.copyFileSync("./BP/manifest.realm.json", `${out}/BP/manifest.json`);
    fs.cpSync("./RP", `${out}/RP`, { recursive: true });
    try {
        execSync("zip -qr ../Sculwave-Realm.mcaddon BP RP", { cwd: out, stdio: "inherit" });
        console.log("Created dist/Sculwave-Realm.mcaddon");
    } catch {
        console.log("zip not found: zip the BP and RP folders in dist/realm and rename the file to .mcaddon");
    }
}
