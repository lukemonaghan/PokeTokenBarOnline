import { Dex, toID } from "@pkmn/sim";
import type { PokemonSet, StatsTable } from "@pkmn/types";

/**
 * A battle-eligible mon as the client reports it — primitives only, never a precomputed stat
 * block. This is the trust boundary: the server derives the real battle mon (stats, moveset)
 * from these via `@pkmn/sim`/`@pkmn/dex` itself, the same way it never trusts a client-reported
 * stat block for anything else. See battles.md's "Trust model" section.
 *
 * `speciesID`/`moves` are PokéAPI primitives (national dex number, hyphenated move slugs) — the
 * same shape the Swift client already works with — not `@pkmn/dex` names. This module is the only
 * place those two vocabularies meet.
 */
export interface MonPrimitive {
  speciesID: number;
  level: number;
  nature: string;
  ability: string;
  ivs: StatsTable;
  evs: StatsTable;
  moves: string[];
}

function isStatsTable(v: unknown): v is StatsTable {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (["hp", "atk", "def", "spa", "spd", "spe"] as const).every((k) => typeof s[k] === "number");
}

export function isMonPrimitive(v: unknown): v is MonPrimitive {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.speciesID === "number" && Number.isInteger(m.speciesID) && m.speciesID > 0 &&
    typeof m.level === "number" && Number.isInteger(m.level) &&
    typeof m.nature === "string" && m.nature.length > 0 &&
    typeof m.ability === "string" && m.ability.length > 0 &&
    isStatsTable(m.ivs) && isStatsTable(m.evs) &&
    Array.isArray(m.moves) && m.moves.length >= 1 && m.moves.length <= 4 &&
    m.moves.every((mv) => typeof mv === "string" && mv.length > 0)
  );
}

/** A roster is 1–6 mons, each a valid primitive. Same shape-check pattern as trades.ts's `isOffer`. */
export function isRoster(v: unknown): v is MonPrimitive[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= 6 && v.every(isMonPrimitive);
}

function clampStat(v: number, max: number): number {
  return Math.min(max, Math.max(0, Math.trunc(v)));
}

/**
 * Clamps untrusted numeric primitives to their legal ranges — same trust-boundary clamp the
 * Swift client's `SaveTransfer.sanitizedMon` already applies (IV 0–31/stat, EV 0–252/stat,
 * 510/total), plus level 1–100. A malicious/buggy client can't submit an over-capped mon and
 * have `@pkmn/sim` compute stats from it — every primitive is clamped before it touches the
 * team-building step below.
 */
function clampPrimitive(m: MonPrimitive): MonPrimitive {
  const ivs = mapStats(m.ivs, (v) => clampStat(v, 31));
  let evs = mapStats(m.evs, (v) => clampStat(v, 252));
  const evTotal = Object.values(evs).reduce((a, b) => a + b, 0);
  if (evTotal > 510) {
    // Scale every stat down proportionally rather than zeroing the excess from one stat — keeps
    // the submitted spread's *shape* while enforcing the total cap, same spirit as clamping each
    // field independently (never trust the client's arithmetic, but don't need to be punitive
    // about which stat "loses" the overflow).
    const scale = 510 / evTotal;
    evs = mapStats(evs, (v) => Math.floor(v * scale));
  }
  return {
    speciesID: m.speciesID,
    level: clampStat(m.level, 100) || 1,
    nature: m.nature,
    ability: m.ability,
    ivs,
    evs,
    moves: m.moves.slice(0, 4),
  };
}

function mapStats(s: StatsTable, fn: (v: number) => number): StatsTable {
  return { hp: fn(s.hp), atk: fn(s.atk), def: fn(s.def), spa: fn(s.spa), spd: fn(s.spd), spe: fn(s.spe) };
}

/** speciesID (PokéAPI national dex number) → `@pkmn/dex` species name, base form only (no
 * Mega/Gmax/regional variants — this app never deals in those). Built once at module load;
 * `@pkmn/dex`'s species table is static data, not something that changes at runtime. */
const speciesNameByID: Map<number, string> = (() => {
  const map = new Map<number, string>();
  for (const species of Dex.species.all()) {
    if (species.forme) continue; // skip Mega/Gmax/regional forms — keep the base entry per number
    if (!map.has(species.num)) map.set(species.num, species.name);
  }
  return map;
})();

export class UnknownSpeciesError extends Error {
  constructor(public readonly speciesID: number) {
    super(`no @pkmn/dex species for national dex number ${speciesID}`);
  }
}

/**
 * Builds a real `@pkmn/sim` `PokemonSet` from a clamped, trusted primitive. `species`/`ability`/
 * `nature` accept raw PokéAPI-style hyphenated slugs directly — `@pkmn/dex` normalizes via `toID`
 * internally on lookup (verified: `Dex.moves.get('quick-attack')`, `Dex.abilities.get('rock-head')`,
 * `Dex.species.get('nidoran-f')` all resolve correctly with no manual cleanup needed here).
 */
export function toPokemonSet(raw: MonPrimitive, nickname: string): PokemonSet {
  const primitive = clampPrimitive(raw);
  const species = speciesNameByID.get(primitive.speciesID);
  if (!species) throw new UnknownSpeciesError(primitive.speciesID);
  return {
    name: nickname,
    species,
    item: "",
    ability: primitive.ability,
    moves: primitive.moves,
    nature: primitive.nature,
    gender: "N",
    evs: primitive.evs,
    ivs: primitive.ivs,
    level: primitive.level,
  };
}

/** Species ids this server can actually field (base forms it has a name for) — used to reject a
 * roster referencing an id `@pkmn/dex` has no data for before it ever reaches `Battle`. */
export function hasSpecies(id: number): boolean {
  return speciesNameByID.has(id);
}

export { toID };
