import type { ActionFormData } from "@minecraft/server-ui";

/**
 * One look for every SculWave form: same title, same body layout, same button colours and icons.
 * Icons are vanilla textures that ship with the game. A path that a client doesn't have simply
 * shows no icon, so nothing breaks if one is missing.
 *
 * Note: Bedrock forms cannot show a player's real skin or face. Every player gets the same
 * generic head icon; the party owner gets a crown.
 */
export const ICON = {
    head: "textures/ui/icon_steve",
    owner: "textures/ui/op",
    party: "textures/ui/FriendsIcon",
    invite: "textures/ui/color_plus",
    invites: "textures/ui/invite_base",
    micOn: "textures/ui/mute_off",
    micOff: "textures/ui/mute_on",
    accept: "textures/ui/check",
    reject: "textures/ui/cancel",
    back: "textures/ui/arrow_left",
    leave: "textures/ui/hammer_l",
    transfer: "textures/ui/dressing_room_customization",
};

export const COLOR = {
    title: "§b",
    label: "§7",
    value: "§f",
    good: "§a",
    bad: "§c",
    warn: "§e",
    muted: "§8",
};

/** "SculWave » Parties" */
export function formTitle(section: string): string {
    return `§l${COLOR.title}SculWave§r ${COLOR.muted}»§r §f${section}`;
}

/** One body line: "Label  value" */
export function line(label: string, value: string): string {
    return `${COLOR.label}${label}: §r${value}`;
}

/** A body made of lines, then an optional hint in grey. */
export function body(lines: string[], hint?: string): string {
    const text = lines.join("\n");
    return hint ? `${text}\n\n${COLOR.muted}${hint}` : text;
}

type Tone = "primary" | "danger" | "neutral" | "good" | "warn";

const TONE: Record<Tone, string> = {
    primary: "§b",
    danger: "§c",
    neutral: "§7",
    good: "§a",
    warn: "§e",
};

/** A button with a consistent colour and optional icon. */
export function button(form: ActionFormData, label: string, tone: Tone = "primary", icon?: string): ActionFormData {
    return icon ? form.button(`${TONE[tone]}${label}`, icon) : form.button(`${TONE[tone]}${label}`);
}

/** Every menu ends with the same Back button. */
export function backButton(form: ActionFormData, label = "Back"): ActionFormData {
    return button(form, label, "neutral", ICON.back);
}
