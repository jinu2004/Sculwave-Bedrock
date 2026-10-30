import { world, system, Player, ItemStack } from '@minecraft/server';
import { http, HttpHeader, HttpRequest } from '@minecraft/server-net';
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
const SERVER_URL = "https://proxybedrock.onrender.com";
const MENU_ITEM_ID = "prox:echowave_radio";
let serverRoomCode = "";
let serverAuthToken = "";
let isRequesting = false; // Prevents spamming the API while waiting for a code
let instanceId = "standalone";
let backendId = "main";
const parties = new Map();
const pendingInvites = new Map();
const playerSettings = new Map();
function createParty(player) {
    const settings = getPlayerSettings(player);
    if (settings.groupId) {
        player.sendMessage("§c[Echowave] Leave your current party first.");
        return;
    }
    const partyId = Math.random().toString(36).substring(2, 10);
    parties.set(partyId, {
        owner: player.name,
        members: new Set([player.name])
    });
    settings.groupId = partyId;
    player.sendMessage(`§a[Echowave] Party created.`);
}
async function showInviteMenu(player) {
    const settings = getPlayerSettings(player);
    // Auto-create party if needed
    if (!settings.groupId) {
        createParty(player);
    }
    if (!settings.groupId)
        return;
    const party = parties.get(settings.groupId);
    if (!party)
        return;
    if (party.owner !== player.name) {
        player.sendMessage("§c[Echowave] Only the party owner can invite players.");
        return;
    }
    const modal = new ModalFormData()
        .title("Invite Player")
        .textField("Enter player's gamertag", "Steve");
    const result = await modal.show(player);
    if (result.canceled || !result.formValues)
        return;
    const gamertag = result.formValues[0].trim();
    if (!gamertag) {
        player.sendMessage("§c[Echowave] Please enter a gamertag.");
        return;
    }
    const target = world.getAllPlayers()
        .find(p => p.name.toLowerCase() === gamertag.toLowerCase());
    if (!target) {
        player.sendMessage(`§c[Echowave] ${gamertag} is not online.`);
        return;
    }
    if (target.name === player.name) {
        player.sendMessage("§c[Echowave] You cannot invite yourself.");
        return;
    }
    if (party.members.has(target.name)) {
        player.sendMessage(`§e[Echowave] ${target.name} is already in your party.`);
        return;
    }
    let invites = pendingInvites.get(target.name) ?? [];
    const alreadyInvited = invites.some(invite => invite.partyId === settings.groupId);
    if (alreadyInvited) {
        player.sendMessage(`§e[Echowave] ${target.name} already has an invite.`);
        return;
    }
    invites.push({ partyId: settings.groupId, owner: player.name });
    pendingInvites.set(target.name, invites);
    target.sendMessage(`§a[Echowave] ${player.name} invited you to a party.`);
    player.sendMessage(`§a[Echowave] Invite sent to ${target.name}.`);
}
async function showInvitesMenu(player) {
    const invites = pendingInvites.get(player.name) ?? [];
    if (invites.length === 0) {
        player.sendMessage("§7No pending invites.");
        return;
    }
    const form = new ActionFormData().title("Party Invites");
    for (const invite of invites) {
        form.button(`${invite.owner}'s Party`);
    }
    const result = await form.show(player);
    if (result.canceled || result.selection === undefined)
        return;
    showInviteActions(player, result.selection);
}
async function showInviteActions(player, inviteIndex) {
    const invites = pendingInvites.get(player.name) ?? [];
    const invite = invites[inviteIndex];
    if (!invite)
        return;
    const form = new ActionFormData()
        .title(`${invite.owner}'s Party`)
        .button("§aAccept Invite")
        .button("§cReject Invite")
        .button("§7Back");
    const result = await form.show(player);
    if (result.canceled || result.selection === undefined)
        return;
    switch (result.selection) {
        case 0:
            joinPartyFromInvite(player, inviteIndex);
            break;
        case 1:
            invites.splice(inviteIndex, 1);
            pendingInvites.set(player.name, invites);
            player.sendMessage(`§cRejected ${invite.owner}'s invite.`);
            break;
        case 2:
            system.run(() => showInvitesMenu(player));
            break;
    }
}
function joinPartyFromInvite(player, inviteIndex) {
    const invites = pendingInvites.get(player.name) ?? [];
    const invite = invites[inviteIndex];
    if (!invite)
        return;
    const party = parties.get(invite.partyId);
    if (!party) {
        player.sendMessage("§cParty no longer exists.");
        return;
    }
    const settings = getPlayerSettings(player);
    if (settings.groupId) {
        player.sendMessage("§cLeave your current party first.");
        return;
    }
    party.members.add(player.name);
    settings.groupId = invite.partyId;
    invites.splice(inviteIndex, 1);
    pendingInvites.set(player.name, invites);
    player.sendMessage(`§aJoined ${invite.owner}'s Party`);
}
async function showManageMembersMenu(player) {
    const settings = getPlayerSettings(player);
    if (!settings.groupId) {
        player.sendMessage("§c[Echowave] You are not in a party.");
        return;
    }
    const party = parties.get(settings.groupId);
    if (!party)
        return;
    if (party.owner !== player.name) {
        player.sendMessage("§c[Echowave] Only the owner can manage members.");
        return;
    }
    const members = [...party.members]
        .filter(member => member !== player.name);
    const form = new ActionFormData()
        .title("§bManage Members");
    for (const member of members) {
        form.button(member);
    }
    form.button("§cBack");
    const result = await form.show(player);
    if (result.canceled || result.selection === undefined)
        return;
    if (result.selection >= members.length) {
        showpartiesMenu(player);
        return;
    }
    const selectedMember = members[result.selection];
    if (selectedMember == null || selectedMember == undefined)
        return;
    showMemberActions(player, selectedMember);
}
async function showMemberActions(owner, memberName) {
    const form = new ActionFormData()
        .title(memberName)
        .button("§cKick Player")
        .button("§eTransfer Ownership")
        .button("§7Cancel");
    const result = await form.show(owner);
    if (result.canceled || result.selection === undefined)
        return;
    const settings = getPlayerSettings(owner);
    const party = parties.get(settings.groupId);
    if (!party)
        return;
    switch (result.selection) {
        case 0:
            party.members.delete(memberName);
            const memberSettings = playerSettings.get(memberName);
            if (memberSettings) {
                memberSettings.groupId = null;
            }
            owner.sendMessage(`§cRemoved ${memberName} from the party.`);
            break;
        case 1:
            party.owner = memberName;
            owner.sendMessage(`§aOwnership transferred to ${memberName}.`);
            break;
    }
    system.run(() => showManageMembersMenu(owner));
}
function isVoiceBanned(playerName) {
    return world.getDynamicProperty(`voiceban_${playerName.toLowerCase()}`) === true;
}
function setVoiceBan(playerName, banned) {
    world.setDynamicProperty(`voiceban_${playerName.toLowerCase()}`, banned);
}
async function registerBackend() {
    if (isRequesting)
        return;
    isRequesting = true;
    try {
        const req = new HttpRequest(`${SERVER_URL}/api/backend/register`);
        req.method = "Post";
        req.headers = [new HttpHeader("Content-Type", "application/json")];
        req.body = JSON.stringify({
            instanceId: instanceId,
            backendId: backendId
        });
        const response = await http.request(req);
        const data = JSON.parse(response.body);
        if (data.success) {
            serverRoomCode = data.roomCode;
            serverAuthToken = data.token;
            // Broadcast the freshly generated code to the first player who joined
            world.sendMessage(`§a[Echowave] Proximity Voice activated for this session!`);
            world.sendMessage(`§7Open Web App: §fhttps://yourdomain.com`);
            world.sendMessage(`§7Enter Code: §e§l${serverRoomCode}`);
            console.info(`[Echowave] Code: ${serverRoomCode}`);
        }
    }
    catch (error) {
        console.warn(`[Echowave] Failed to get dynamic room code: ${error}`);
    }
    finally {
        isRequesting = false;
    }
}
async function sendCoordinatesToServer(playerData) {
    try {
        const req = new HttpRequest(`${SERVER_URL}/api/backend/heartbeat`);
        req.method = "Post";
        req.headers = [new HttpHeader("Content-Type", "application/json")];
        req.body = JSON.stringify({
            instanceId: instanceId,
            backendId: backendId,
            token: serverAuthToken,
            timestamp: Date.now(),
            players: playerData
        });
        const response = await http.request(req);
        let data;
        try {
            data = JSON.parse(response.body);
        }
        catch {
            console.warn("Invalid response from server.");
            return;
        }
        if (data.error === "BACKEND_NOT_FOUND" ||
            data.error === "AUTH_FAILED") {
            serverRoomCode = "";
            serverAuthToken = "";
            registerBackend();
        }
    }
    catch (e) {
        console.warn(`[Echowave] Update failed: ${e}`);
    }
}
function getPlayerSettings(player) {
    let settings = playerSettings.get(player.name);
    if (!settings) {
        settings = {
            isMuted: false,
            groupId: null
        };
        playerSettings.set(player.name, settings);
    }
    return settings;
}
async function showpartiesMenu(player) {
    const settings = getPlayerSettings(player);
    const inviteCount = pendingInvites.get(player.name)?.length ?? 0;
    let currentPartyDisplay = "§7Public Proximity";
    if (settings.groupId) {
        const party = parties.get(settings.groupId);
        if (party) {
            currentPartyDisplay =
                `§b${party.owner}'s Party`;
        }
    }
    const form = new ActionFormData()
        .title("§bEchowave > Parties")
        .body(`Channel: ${currentPartyDisplay}\n\n` +
        `§7Party members can hear each other across the entire world.`)
        .button("§eInvite Player")
        .button(`§dInvites (${inviteCount})`)
        .button("§bView Members")
        .button("§cLeave Party")
        .button("§cBack");
    const result = await form.show(player);
    if (result.canceled) {
        return;
    }
    switch (result.selection) {
        case 0:
            system.run(() => { showInviteMenu(player); });
            break;
        case 1:
            system.run(() => {
                showInvitesMenu(player);
            });
            break;
        case 2: {
            if (!settings.groupId) {
                player.sendMessage("§c[Echowave] You are not in a party.");
                break;
            }
            const party = parties.get(settings.groupId);
            if (!party) {
                player.sendMessage("§c[Echowave] Party not found.");
                break;
            }
            const memberForm = new ActionFormData()
                .title("§bParty Members")
                .body(`§7Owner: §e${party.owner}\n\n` +
                `§bMembers (${party.members.size})`);
            for (const member of party.members) {
                const isOwner = member === party.owner;
                memberForm.button(isOwner
                    ? `§e${member}`
                    : `§7${member}`);
            }
            memberForm.button("§cBack");
            memberForm.show(player).then(() => {
                system.run(() => showpartiesMenu(player));
            });
            break;
        }
        case 3: {
            if (!settings.groupId) {
                player.sendMessage("§c[Echowave] You are not in a party.");
                break;
            }
            const party = parties.get(settings.groupId);
            if (!party) {
                settings.groupId = null;
                break;
            }
            if (party.owner === player.name) {
                parties.delete(settings.groupId);
                player.sendMessage("§c[Echowave] Party disbanded.");
            }
            else {
                party.members.delete(player.name);
                player.sendMessage("§c[Echowave] Left party.");
            }
            settings.groupId = null;
            system.run(() => showpartiesMenu(player));
            break;
        }
        case 4:
            system.run(() => showVoiceMenu(player));
            break;
    }
}
async function showVoiceMenu(player) {
    const settings = getPlayerSettings(player);
    let groupLabel = "§7None (EchoWave)";
    if (settings.groupId) {
        const currentGroup = parties.get(settings.groupId);
        if (currentGroup) {
            groupLabel = `§b${currentGroup.owner}`;
        }
    }
    const form = new ActionFormData()
        .title("§bEchowave Main Menu")
        .body(`Mic Status: ${settings.isMuted ? "§cMUTED" : "§aACTIVE"}\n` +
        `Group: ${groupLabel}\n` +
        `Room Code: §e${serverRoomCode || "Connecting..."}`)
        .button(settings.isMuted ? "§aUnmute Mic" : "§cMute Mic")
        .button("§bManage parties")
        .button("§cClose Menu");
    const result = await form.show(player);
    if (result.canceled)
        return;
    switch (result.selection) {
        case 0:
            settings.isMuted = !settings.isMuted;
            player.sendMessage(settings.isMuted ? "§c[Echowave] Microphone muted." : "§a[Echowave] Microphone active.");
            system.run(() => {
                showVoiceMenu(player);
            });
            break;
        case 1:
            system.run(() => showpartiesMenu(player));
            break;
        case 2:
            // Closes safely
            break;
    }
}
system.afterEvents.scriptEventReceive.subscribe((event) => {
    const sender = event.sourceEntity;
    if (!(sender instanceof Player)) {
        return;
    }
    if (!sender.hasTag("admin")) {
        sender.sendMessage("§c[Echowave] You don't have permission.");
        return;
    }
    if (!event.id.startsWith("echowave:"))
        return;
    const target = event.message.trim();
    switch (event.id) {
        case "echowave:voiceban":
            if (!target)
                return;
            setVoiceBan(target, true);
            world.sendMessage(`§c[Echowave] ${target} has been banned from voice chat.`);
            break;
        case "echowave:voiceunban":
            if (!target)
                return;
            setVoiceBan(target, false);
            world.sendMessage(`§a[Echowave] ${target} has been unbanned from voice chat.`);
            break;
        case "echowave:voicecheck":
            if (!target)
                return;
            sender.sendMessage(`§e[Echowave] ${target}: ${isVoiceBanned(target) ? "BANNED" : "ALLOWED"}`);
            break;
        case "echowave:config": {
            const args = event.message.trim().split(/\s+/);
            if (args.length !== 2) {
                sender.sendMessage("§cUsage: /scriptevent echowave:config <instanceId> <backendId>");
                break;
            }
            const instance = args[0] ?? "standalone";
            const backend = args[1] ?? "main";
            world.setDynamicProperty("echowave:instance", instance);
            world.setDynamicProperty("echowave:backend", backend);
            instanceId = instance;
            backendId = backend;
            serverRoomCode = "";
            serverAuthToken = "";
            registerBackend();
            sender.sendMessage(`§a[Echowave] Configuration updated.\n` +
                `§7Instance: §f${instance}\n` +
                `§7Backend: §f${backend}`);
            break;
        }
        case "echowave:status": {
            sender.sendMessage(`§6=== Echowave ===\n` +
                `§7Instance: §f${instanceId}\n` +
                `§7Backend: §f${backendId}\n` +
                `§7Room: §f${serverRoomCode || "Not Registered"}\n` +
                `§7Connected: §f${serverAuthToken ? "Yes" : "No"}`);
            break;
        }
    }
});
world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn)
        return;
    const player = event.player;
    if (isVoiceBanned(player.name))
        return;
    const inv = player.getComponent("minecraft:inventory")?.container;
    if (inv) {
        inv.addItem(new ItemStack(RADIO_ID, 1));
    }
});
world.beforeEvents.itemUse.subscribe((event) => {
    const player = event.source;
    if (isVoiceBanned(player.name)) {
        player.sendMessage("§cYou are banned from voice chat.");
        event.cancel = true;
        return;
    }
    if (event.itemStack.typeId !== MENU_ITEM_ID)
        return;
    event.cancel = true;
    system.run(() => showVoiceMenu(player));
});
world.afterEvents.worldLoad.subscribe(() => {
    console.warn(`[Echowave] Server initialized. Requesting persistent room code...`);
    instanceId =
        world.getDynamicProperty("echowave:instance")
            ?? "standalone";
    backendId =
        world.getDynamicProperty("echowave:backend")
            ?? "main";
    registerBackend();
});
system.runInterval(() => {
    const allPlayers = world.getAllPlayers();
    if (allPlayers.length > 0 && serverRoomCode === "") {
        registerBackend();
        return;
    }
    if (serverRoomCode !== "") {
        const playerData = [];
        for (const player of allPlayers) {
            if (isVoiceBanned(player.name)) {
                continue;
            }
            const pos = player.location;
            const settings = getPlayerSettings(player);
            playerData.push({
                gamertag: player.name,
                x: Math.round(pos.x),
                y: Math.round(pos.y),
                z: Math.round(pos.z),
                dimension: player.dimension.id,
                groupId: settings.groupId,
                isMuted: settings.isMuted
            });
            if (settings.isMuted) {
                player.nameTag = `[muted] ${player.name}`;
            }
            else {
                player.nameTag = `[unmuted] ${player.name}`;
            }
        }
        sendCoordinatesToServer(playerData);
    }
}, 20);
const RADIO_ID = "prox:echowave_radio";
system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        if (isVoiceBanned(player.name))
            continue;
        const inv = player.getComponent("minecraft:inventory")?.container;
        if (!inv)
            continue;
        let hasRadio = false;
        for (let i = 0; i < inv.size; i++) {
            const item = inv.getItem(i);
            if (item?.typeId === RADIO_ID) {
                hasRadio = true;
                break;
            }
        }
        if (!hasRadio) {
            inv.addItem(new ItemStack(RADIO_ID, 1));
        }
    }
}, 100);
// Show the active code to individual late-joining players when they spawn
world.afterEvents.playerSpawn.subscribe((event) => {
    const player = event.player;
    if (isVoiceBanned(player.name)) {
        return; // don't send room code
    }
    if (event.initialSpawn && serverRoomCode !== "") {
        player.sendMessage(`§a[Echowave] Proximity Voice is active!`);
        player.sendMessage(`§7Open Web App: §fhttps://proxybedrock.onrender.com`);
        player.sendMessage(`§7Your Code is: §e§l${serverRoomCode}`);
    }
});
world.afterEvents.playerLeave.subscribe((event) => {
    const playerName = event.playerName;
    playerSettings.delete(playerName);
    for (const [partieOwnerName, partie] of parties.entries()) {
        if (partie.owner === playerName) {
            for (const member of partie.members) {
                const settings = playerSettings.get(member);
                if (settings) {
                    settings.groupId = null;
                }
            }
            parties.delete(partieOwnerName);
            console.warn(`[Echowave] Group "${partieOwnerName}" disbanded because owner left.`);
        }
    }
});
//# sourceMappingURL=main.js.map