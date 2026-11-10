import { world, system, Player, ItemStack } from '@minecraft/server';
import { BackendConnection, BackendPlayerPayload, VoiceStatePayload } from './backend/BackendConnection';
import { versionInfo } from './version';
import { BackendConfig } from './generated/config';
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";



const SERVER_URL = BackendConfig.serverUrl;
const MENU_ITEM_ID = "prox:sculwave_mic";
const ACTIVATION_KEY_PROPERTY = "sculwave:activationKey";
const INSTANCE_ID_PROPERTY = "sculwave:instance";
const BACKEND_ID_PROPERTY = "sculwave:backend";
const SERVER_NAME_PROPERTY = "sculwave:serverName";
const BEDROCK_PLATFORM = "bedrock";
const MINECRAFT_VERSION = "1.26.60";

let serverRoomCode = "";
let instanceId = "";
let backendId = "";
let heartbeatIntervalMs = 1000;
let lastHeartbeatAt = 0;
let backendConnection: BackendConnection | undefined;
let initializationInProgress = false;
let activationRetryScheduled = false;
// Custom glyphs from RP/font/glyph_E4.png
const MIC_IDLE_ICON = "\uE400";
const MIC_MUTED_ICON = "\uE401";
const MIC_SPEAKING_ICON = "\uE402";









interface PlayerSettings {
    isMuted: boolean;
    groupId: string | null;
}

interface PartyData {
    owner: string;
    members: Set<string>;
}

interface PartyInvite {
    partyId: string;
    owner: string;
}

const parties = new Map<string, PartyData>();

const pendingInvites = new Map<string, PartyInvite[]>();

const playerSettings = new Map<string, PlayerSettings>()


const voiceStates = new Map<string, VoiceStatePayload>();

function updateNameTag(player: Player): void {
    const state = voiceStates.get(player.name.toLowerCase());
    const inGameMuted = getPlayerSettings(player).isMuted;

    let tag = player.name; // not connected to the web app: plain name

    if (inGameMuted || (state?.connected && state.muted)) {
        tag = `${MIC_MUTED_ICON} ${player.name}`;
    } else if (state?.connected && state.speaking) {
        tag = `${MIC_SPEAKING_ICON} ${player.name}`;
    } else if (state?.connected) {
        tag = `${MIC_IDLE_ICON} ${player.name}`;
    }

    if (player.nameTag !== tag) player.nameTag = tag;
}

function handleVoiceState(state: VoiceStatePayload): void {
    const key = state.gamertag.toLowerCase();

    if (state.connected) voiceStates.set(key, state);
    else voiceStates.delete(key);

    const player = world.getAllPlayers().find(p => p.name.toLowerCase() === key);
    if (player && !isVoiceBanned(player.name)) updateNameTag(player);
}

function resetVoiceStates(): void {
    voiceStates.clear();
    for (const player of world.getAllPlayers()) {
        if (!isVoiceBanned(player.name)) updateNameTag(player);
    }
}



function createParty(player: Player) {

    const settings = getPlayerSettings(player);

    if (settings.groupId) {
        player.sendMessage("§c[Sculwave] Leave your current party first.");
        return;
    }

    const partyId = Math.random().toString(36).substring(2, 10);

    parties.set(partyId, {
        owner: player.name,
        members: new Set([player.name])
    });
    settings.groupId = partyId;
    player.sendMessage(`§a[Sculwave] Party created.`);
}


async function showInviteMenu(player: Player) {

    const settings = getPlayerSettings(player);

    // Auto-create party if needed
    if (!settings.groupId) {
        createParty(player);
    }

    if (!settings.groupId) return

    const party = parties.get(settings.groupId);

    if (!party) return

    if (party.owner !== player.name) {
        player.sendMessage("§c[Sculwave] Only the party owner can invite players.");
        return;
    }

    const modal = new ModalFormData()
        .title("Invite Player")
        .textField(
            "Enter player's gamertag",
            "Steve"
        );

    const result = await modal.show(player);

    if (result.canceled || !result.formValues) return

    const gamertag = (result.formValues[0] as string).trim();

    if (!gamertag) {
        player.sendMessage("§c[Sculwave] Please enter a gamertag.");
        return;
    }

    const target = world.getAllPlayers()
        .find(
            p => p.name.toLowerCase() === gamertag.toLowerCase()
        );

    if (!target) {
        player.sendMessage(`§c[Sculwave] ${gamertag} is not online.`);
        return;
    }

    if (target.name === player.name) {
        player.sendMessage("§c[Sculwave] You cannot invite yourself.");
        return;
    }

    if (party.members.has(target.name)) {
        player.sendMessage(`§e[Sculwave] ${target.name} is already in your party.`);
        return;
    }

    let invites = pendingInvites.get(target.name) ?? [];

    const alreadyInvited = invites.some(
        invite =>
            invite.partyId === settings.groupId
    );

    if (alreadyInvited) {
        player.sendMessage(`§e[Sculwave] ${target.name} already has an invite.`);
        return;
    }

    invites.push({ partyId: settings.groupId, owner: player.name });

    pendingInvites.set(target.name, invites);

    target.sendMessage(`§a[Sculwave] ${player.name} invited you to a party.`);

    player.sendMessage(`§a[Sculwave] Invite sent to ${target.name}.`);
}



async function showInvitesMenu(player: Player) {

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

    if (result.canceled || result.selection === undefined) return

    showInviteActions(
        player,
        result.selection
    );
}

async function showInviteActions(
    player: Player,
    inviteIndex: number
) {

    const invites = pendingInvites.get(player.name) ?? [];

    const invite = invites[inviteIndex];

    if (!invite) return

    const form = new ActionFormData()
        .title(`${invite.owner}'s Party`)
        .button("§aAccept Invite")
        .button("§cReject Invite")
        .button("§7Back");

    const result = await form.show(player);

    if (result.canceled || result.selection === undefined) return

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
            system.run(() =>
                showInvitesMenu(player)
            );

            break;
    }
}


function joinPartyFromInvite(
    player: Player,
    inviteIndex: number
) {

    const invites = pendingInvites.get(player.name) ?? [];

    const invite = invites[inviteIndex];
    if (!invite) return;

    const party = parties.get(invite.partyId);

    if (!party) {
        player.sendMessage("§cParty no longer exists.");
        return;
    }

    const settings = getPlayerSettings(player);

    if (settings.groupId) {
        player.sendMessage(
            "§cLeave your current party first."
        );
        return;
    }

    party.members.add(player.name);
    settings.groupId = invite.partyId;
    invites.splice(inviteIndex, 1);
    pendingInvites.set(
        player.name,
        invites
    );

    player.sendMessage(`§aJoined ${invite.owner}'s Party`);
}


async function showManageMembersMenu(player: Player) {

    const settings = getPlayerSettings(player);

    if (!settings.groupId) {
        player.sendMessage("§c[Sculwave] You are not in a party.");
        return;
    }
    const party = parties.get(settings.groupId);
    if (!party) return
    if (party.owner !== player.name) {
        player.sendMessage("§c[Sculwave] Only the owner can manage members.");
        return;
    }

    const members =
        [...party.members]
            .filter(
                member =>
                    member !== player.name
            );

    const form = new ActionFormData()
        .title("§bManage Members");

    for (const member of members) {
        form.button(member);
    }

    form.button("§cBack");

    const result = await form.show(player);

    if (result.canceled || result.selection === undefined) return

    if (result.selection >= members.length) {
        showpartiesMenu(player);
        return;
    }

    const selectedMember = members[result.selection];
    if (selectedMember == null || selectedMember == undefined) return

    showMemberActions(player, selectedMember);
}


async function showMemberActions(
    owner: Player,
    memberName: string
) {

    const form =
        new ActionFormData()
            .title(memberName)
            .button("§cKick Player")
            .button("§eTransfer Ownership")
            .button("§7Cancel");

    const result = await form.show(owner);

    if (result.canceled || result.selection === undefined) return

    const settings = getPlayerSettings(owner);

    const party = parties.get(settings.groupId!);

    if (!party) return

    switch (result.selection) {

        case 0:

            party.members.delete(memberName);
            const memberSettings = playerSettings.get(memberName);
            if (memberSettings) { memberSettings.groupId = null; }
            owner.sendMessage(`§cRemoved ${memberName} from the party.`);
            system.run(() => showManageMembersMenu(owner));
            break;

        case 1:
            party.owner = memberName;
            owner.sendMessage(`§aOwnership transferred to ${memberName}.`);
            system.run(() => showpartiesMenu(owner));
            break;
    }

    system.run(() =>
        showManageMembersMenu(owner)
    );
}






function isVoiceBanned(playerName: string): boolean {
    return world.getDynamicProperty(
        `voiceban_${playerName.toLowerCase()}`
    ) === true;
}

function setVoiceBan(playerName: string, banned: boolean) {
    world.setDynamicProperty(
        `voiceban_${playerName.toLowerCase()}`,
        banned
    );
}



async function initializeBackend(): Promise<void> {
    if (initializationInProgress) return;

    const activationKey =
        ((world.getDynamicProperty(ACTIVATION_KEY_PROPERTY) as string | undefined)
            ?? BackendConfig.activationKey).trim();

    if (!activationKey) {
        console.warn(
            `[Sculwave] No activation key configured. Use /scriptevent sculwave:activation <key>.`
        );
        return;
    }

    initializationInProgress = true;

    try {
        backendConnection?.disconnect();

        backendConnection = new BackendConnection(
            SERVER_URL,
            activationKey,
            backendId,
            instanceId,
            (world.getDynamicProperty(SERVER_NAME_PROPERTY) as string | undefined)
            ?? BackendConfig.serverName,
            versionInfo.version,
            MINECRAFT_VERSION,
            (state) => {
                backendId = state.backendId;
                instanceId = state.instanceId;
                heartbeatIntervalMs = state.heartbeatInterval;

                world.setDynamicProperty(BACKEND_ID_PROPERTY, backendId);
                world.setDynamicProperty(INSTANCE_ID_PROPERTY, instanceId);
            },
            (roomCode) => {
                
                serverRoomCode = roomCode;

                if (!roomCode) return;

                world.sendMessage(`§a[Sculwave] Proximity Voice activated!`);
                world.sendMessage(`§7Open Web App: §fhttps://sculwave.com`);
                world.sendMessage(`§7Enter Code: §e§l${roomCode}`);
                console.info(`[Sculwave] Room Code: ${roomCode}`);
            },
            handleVoiceState,resetVoiceStates
        );

        const activated = await backendConnection.activate();
        if (!activated) {
            scheduleActivationRetry();
            return;
        }

        heartbeatIntervalMs = backendConnection.heartbeatInterval;
        await backendConnection.connect();
    } finally {
        initializationInProgress = false;
    }
}

function scheduleActivationRetry(): void {
    if (activationRetryScheduled) return;

    activationRetryScheduled = true;
    system.runTimeout(() => {
        activationRetryScheduled = false;
        void initializeBackend();
    }, 200);
}

function getPlayerData(): BackendPlayerPayload[] {
    const playerData: BackendPlayerPayload[] = [];

    for (const player of world.getAllPlayers()) {
        if (isVoiceBanned(player.name)) continue;

        const pos = player.location;
        const settings = getPlayerSettings(player);

        playerData.push({
            gamertag: player.name,
            x: Math.round(pos.x),
            y: Math.round(pos.y),
            z: Math.round(pos.z),
            dimension: normalizeDimension(player.dimension.id),
            groupId: settings.groupId,
            isMuted: settings.isMuted,
            platform: BEDROCK_PLATFORM,
            device: "unknown",
        });

        updateNameTag(player);


    }

    return playerData;
}

function normalizeDimension(dimension: string): string {
    switch (dimension) {
        case "minecraft:nether":
            return "nether";
        case "minecraft:the_end":
            return "the_end";
        case "minecraft:overworld":
        default:
            return "overworld";
    }
}

function sendHeartbeatIfDue(): void {
    if (!backendConnection?.isAuthenticated) return;

    const now = Date.now();
    if (now - lastHeartbeatAt < heartbeatIntervalMs) return;

    lastHeartbeatAt = now;
    backendConnection.sendHeartbeat(getPlayerData(), true);
}


function getPlayerSettings(player: Player): PlayerSettings {
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



async function showpartiesMenu(player: Player) {
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
        .title("§bSculwave > Parties")
        .body(
            `Channel: ${currentPartyDisplay}\n\n` +
            `§7Party members can hear each other across the entire world.`
        )
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
            system.run(() => { showInviteMenu(player) });
            break;

        case 1:
            system.run(() => {
                showInvitesMenu(player);
            });
            break;

        case 2: {

            if (!settings.groupId) {
                player.sendMessage("§c[Sculwave] You are not in a party.");
                break;
            }

            const party = parties.get(settings.groupId);

            if (!party) {
                player.sendMessage("§c[Sculwave] Party not found."
                );
                break;
            }

            if (party.owner === player.name) {
                system.run(() => showManageMembersMenu(player));
                break;
            }

            const memberForm = new ActionFormData()
                .title("§bParty Members")
                .body(
                    `§7Owner: §e${party.owner}\n\n` +
                    `§bMembers (${party.members.size})`
                );

            for (const member of party.members) {

                const isOwner = member === party.owner;

                memberForm.button(
                    isOwner
                        ? `§e${member}`
                        : `§7${member}`
                );
            }

            memberForm.button("§cBack");

            memberForm.show(player).then(() => {
                system.run(() =>
                    showpartiesMenu(player)
                );
            });

            break;
        }

        case 3: {

            if (!settings.groupId) {
                player.sendMessage("§c[Sculwave] You are not in a party.");
                break;
            }

            const party = parties.get(settings.groupId);

            if (!party) {
                settings.groupId = null;
                break;
            }

            if (party.owner === player.name) {
                for (const m of party.members) {
                    const s = playerSettings.get(m);
                    if (s) s.groupId = null;
                }
                parties.delete(settings.groupId);
                player.sendMessage("§c[Sculwave] Party disbanded.");
            } else {
                party.members.delete(player.name);
                player.sendMessage("§c[Sculwave] Left party.");
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





async function showVoiceMenu(player: Player) {
    const settings = getPlayerSettings(player);
    let groupLabel = "§7None (sculwave)";
    if (settings.groupId) {
        const currentGroup = parties.get(settings.groupId);
        if (currentGroup) {
            groupLabel = `§b${currentGroup.owner}`;
        }
    }
    const form = new ActionFormData()
        .title("§bSculwave Main Menu")
        .body(
            `Mic Status: ${settings.isMuted ? "§cMUTED" : "§aACTIVE"}\n` +
            `Group: ${groupLabel}\n` +
            `Room Code: §e${serverRoomCode || "Connecting..."}`
        )
        .button(settings.isMuted ? "§aUnmute Mic" : "§cMute Mic")
        .button("§bManage parties",)
        .button("§cClose Menu");

    const result = await form.show(player);
    if (result.canceled) return;

    switch (result.selection) {
        case 0:
            settings.isMuted = !settings.isMuted;
            player.sendMessage(settings.isMuted ? "§c[Sculwave] Microphone muted." : "§a[Sculwave] Microphone active.");
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

    if (!event.id.startsWith("sculwave:")) return;
    const sender = event.sourceEntity;

    if (!(sender instanceof Player)) {
        return;
    }

    if (!sender.hasTag("admin")) {
        sender.sendMessage(
            "§c[Sculwave] You don't have permission."
        );
        return;
    }
    if (!event.id.startsWith("sculwave:")) return;

    const target = event.message.trim();

    switch (event.id) {

        case "sculwave:voiceban":
            if (!target) return;

            setVoiceBan(target, true);

            world.sendMessage(
                `§c[Sculwave] ${target} has been banned from voice chat.`
            );
            break;

        case "sculwave:voiceunban":
            if (!target) return;

            setVoiceBan(target, false);

            world.sendMessage(
                `§a[Sculwave] ${target} has been unbanned from voice chat.`
            );
            break;

        case "sculwave:voicecheck":
            if (!target) return;

            sender.sendMessage(
                `§e[Sculwave] ${target}: ${isVoiceBanned(target) ? "BANNED" : "ALLOWED"
                }`
            );
            break;
        case "sculwave:activation": {
            const key = event.message.trim();

            if (!key) {
                sender.sendMessage("§cUsage: /scriptevent sculwave:activation <activation-key>");
                break;
            }

            world.setDynamicProperty(ACTIVATION_KEY_PROPERTY, key);
            backendConnection?.disconnect();
            backendConnection = undefined;
            serverRoomCode = "";
            instanceId = "";
            backendId = "";
            lastHeartbeatAt = 0;

            sender.sendMessage("§a[Sculwave] Activation key saved. Activating server...");
            void initializeBackend();
            break;
        }

        case "sculwave:servername": {
            const name = event.message.trim();
            if (!name) {
                sender.sendMessage("§cUsage: /scriptevent sculwave:servername <name>");
                break;
            }

            world.setDynamicProperty(SERVER_NAME_PROPERTY, name);
            sender.sendMessage(`§a[Sculwave] Server name saved as ${name}. Re-activate to apply it.`);
            break;
        }

        case "sculwave:status": {
            sender.sendMessage(
                `§6=== Sculwave ===\n` +
                `§7Instance: §f${instanceId || "Not Activated"}\n` +
                `§7Backend: §f${backendId || "Not Activated"}\n` +
                `§7Room: §f${serverRoomCode || "Not Registered"}\n` +
                `§7Connected: §f${backendConnection?.isAuthenticated ? "Yes" : "No"}`
            );
            break;
        }
    }
});

const RADIO_ID = "prox:sculwave_mic";


world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn) return;
    const player = event.player;
    if (isVoiceBanned(player.name)) return;
    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) return;
    for (let i = 0; i < inv.size; i++) {
        if (inv.getItem(i)?.typeId === RADIO_ID) return;
    }
    inv.addItem(new ItemStack(RADIO_ID, 1));
});


world.beforeEvents.itemUse.subscribe((event) => {
    const player = event.source as Player;

    if (isVoiceBanned(player.name)) {
        player.sendMessage("§cYou are banned from voice chat.");
        event.cancel = true;
        return;
    }

    if (event.itemStack.typeId !== MENU_ITEM_ID) return;

    event.cancel = true;
    system.run(() => showVoiceMenu(player));
});



world.afterEvents.worldLoad.subscribe(() => {
    console.warn(`[Sculwave] Server initialized. Starting sculwave activation...`);

    instanceId =
        (world.getDynamicProperty(INSTANCE_ID_PROPERTY) as string | undefined)
        ?? "";

    backendId =
        (world.getDynamicProperty(BACKEND_ID_PROPERTY) as string | undefined)
        ?? "";

    system.run(() => void initializeBackend());
})


system.runInterval(() => {
    sendHeartbeatIfDue();
}, 20);



world.afterEvents.playerSpawn.subscribe((event) => {
    const player = event.player;

    if (isVoiceBanned(player.name)) {
        return; // don't send room code
    }

    if (event.initialSpawn && serverRoomCode !== "") {
        player.sendMessage(`§a[Sculwave] Proximity Voice is active!`);
        player.sendMessage(`§7Open Web App: §fhttps://sculwave.com`);
        player.sendMessage(`§7Your Code is: §e§l${serverRoomCode}`);
    }
});

world.afterEvents.playerLeave.subscribe((event) => {
    const name = event.playerName;
    playerSettings.delete(name);
    pendingInvites.delete(name);
    voiceStates.delete(name.toLowerCase());

    for (const [partyId, party] of parties.entries()) {
        if (party.owner === name) {
            for (const m of party.members) {
                const s = playerSettings.get(m);
                if (s) s.groupId = null;
            }
            parties.delete(partyId);
        } else {
            party.members.delete(name);
        }
    }

    for (const [target, invites] of pendingInvites.entries()) {
        pendingInvites.set(target, invites.filter(i => parties.has(i.partyId)));
    }
});

