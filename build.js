import fs from "fs";
import { execSync } from "child_process";

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
    }, null, 4)} as const;\n`
);



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