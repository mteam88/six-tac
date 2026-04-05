import type { BotCatalogEntry, BotExecution, BotName } from "./types";

export type BotMetadata = {
  name: BotName;
  label: string;
  description: string;
  execution: BotExecution;
  offlineCapable: boolean;
};

export const BOT_METADATA: Record<BotName, BotMetadata> = {
  sprout: {
    name: "sprout",
    label: "Sprout",
    description: "Random legal-move baseline.",
    execution: "worker",
    offlineCapable: true,
  },
  seal: {
    name: "seal",
    label: "Seal",
    description: "Vendored Ramora0 SealBot minimax via the upstream engine bridge.",
    execution: "worker",
    offlineCapable: true,
  },
  ambrosia: {
    name: "ambrosia",
    label: "Ambrosia",
    description: "Feature-weighted heuristic search inspired by trueharuu's Ambrosia project.",
    execution: "worker",
    offlineCapable: true,
  },
  hydra: {
    name: "hydra",
    label: "Hydra",
    description: "Deeper tactical search with forced-block defense and fork planning.",
    execution: "worker",
    offlineCapable: true,
  },
  orca: {
    name: "orca",
    label: "Orca",
    description: "Balanced generic minimax with threat-cover scoring.",
    execution: "worker",
    offlineCapable: true,
  },
  kraken: {
    name: "kraken",
    label: "Kraken",
    description: "Hosted Ramora0 KrakenBot neural MCTS from the native Rust + Python runtime.",
    execution: "remote",
    offlineCapable: false,
  },
  hexgo: {
    name: "hexgo",
    label: "HexGo",
    description: "Hosted sub-surface/hexgo net.py checkpoint via the native Rust + Python bridge.",
    execution: "remote",
    offlineCapable: false,
  },
};

export const BOT_ORDER: BotName[] = ["sprout", "seal", "ambrosia", "hydra", "orca", "kraken", "hexgo"];

export function botLabel(botName: BotName): string {
  return BOT_METADATA[botName].label;
}

export function botDescription(botName: BotName): string {
  return BOT_METADATA[botName].description;
}

export function buildBotCatalogEntry(
  botName: BotName,
  options: Partial<Pick<BotCatalogEntry, "available" | "execution" | "offlineCapable" | "version">> = {},
): BotCatalogEntry {
  const metadata = BOT_METADATA[botName];
  return {
    ...metadata,
    available: options.available ?? true,
    execution: options.execution ?? metadata.execution,
    offlineCapable: options.offlineCapable ?? metadata.offlineCapable,
    version: options.version ?? (metadata.execution === "remote" ? `${botName}_v1` : "builtin"),
  };
}
