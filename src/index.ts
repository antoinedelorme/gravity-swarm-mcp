#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

// ─── Config ──────────────────────────────────────────────

const API = "https://gravity-swarm.org/api";
const IDENTITY_DIR = join(homedir(), ".gravity-swarm");
const IDENTITY_FILE = join(IDENTITY_DIR, "identity.json");

// ─── Identity Manager ────────────────────────────────────

interface Identity {
  secretKeyHex: string;
  publicKeyHex: string;
  agentId: string | null;
  name: string | null;
}

function loadOrCreateIdentity(): Identity {
  if (existsSync(IDENTITY_FILE)) {
    const raw = readFileSync(IDENTITY_FILE, "utf-8");
    return JSON.parse(raw) as Identity;
  }
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const identity: Identity = {
    secretKeyHex: bytesToHex(sk),
    publicKeyHex: pk,
    agentId: null,
    name: null,
  };
  mkdirSync(IDENTITY_DIR, { recursive: true });
  writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2));
  return identity;
}

function saveIdentity(id: Identity): void {
  mkdirSync(IDENTITY_DIR, { recursive: true });
  writeFileSync(IDENTITY_FILE, JSON.stringify(id, null, 2));
}

function getSecretKey(id: Identity): Uint8Array {
  return hexToBytes(id.secretKeyHex);
}

// ─── Nostr Event Signing ─────────────────────────────────

function signEvent(sk: Uint8Array, tags: string[][], content: string = "") {
  return finalizeEvent(
    {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    },
    sk,
  );
}

// ─── Crypto Helpers ──────────────────────────────────────

function sha256hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

// ─── Seeded PRNG (xorshift128+) — canonical impl ────────

function xorshift128plus(seed: string): () => number {
  let s0 = 0;
  let s1 = 0;
  for (let i = 0; i < seed.length; i++) {
    s0 = (s0 * 31 + seed.charCodeAt(i)) >>> 0;
    s1 = (s1 * 37 + seed.charCodeAt(i)) >>> 0;
  }
  if (s0 === 0) s0 = 1;
  if (s1 === 0) s1 = 1;
  return function () {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= x << 23;
    x ^= x >>> 17;
    x ^= y;
    x ^= y >>> 26;
    s1 = x;
    return (s0 + s1) >>> 0;
  };
}

function generateData(seed: string, size: number): Float64Array {
  const rng = xorshift128plus(seed);
  const data = new Float64Array(size);
  for (let i = 0; i < size; i++) data[i] = (rng() / 4294967296) * 2 - 1;
  return data;
}

// ─── FFT (radix-2 Cooley-Tukey) — canonical impl ────────

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe =
          re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm =
          re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const tmpRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = tmpRe;
      }
    }
  }
}

// ─── Task Processors ─────────────────────────────────────

function processFFT(
  seed: string,
  shardSize: number,
): { output_hash: string } {
  let n = 1;
  while (n < shardSize) n <<= 1;
  const data = generateData(seed, n);
  const re = new Float64Array(data);
  const im = new Float64Array(n);
  fft(re, im);
  const mags = new Float64Array(n);
  for (let i = 0; i < n; i++)
    mags[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  const magStr = Array.from(mags)
    .map((v) => v.toFixed(6))
    .join(",");
  return { output_hash: sha256hex(magStr) };
}

function processShaChain(
  seed: string,
  shardSize: number,
): { output_hash: string } {
  const rounds = Math.min(shardSize, 10000);
  let h = seed;
  for (let i = 0; i < rounds; i++) h = sha256hex(h);
  return { output_hash: h };
}

function processMonteCarlo(
  seed: string,
  shardSize: number,
): { output_hash: string } {
  const rng = xorshift128plus(seed);
  let inside = 0;
  for (let i = 0; i < shardSize; i++) {
    const x = rng() / 4294967296;
    const y = rng() / 4294967296;
    if (x * x + y * y < 1.0) inside++;
  }
  const result = ((4.0 * inside) / shardSize).toFixed(10);
  return { output_hash: sha256hex(result) };
}

function processSimulation(
  seed: string,
  shardSize: number,
): { output_hash: string; output_value: string } {
  let n = 1;
  while (n < shardSize) n <<= 1;
  const data = generateData(seed, n);
  const re = new Float64Array(data);
  const im = new Float64Array(n);
  fft(re, im);
  let sum = 0;
  for (let i = 0; i < n; i++)
    sum += Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    variance += (mag - mean) * (mag - mean);
  }
  const stddev = Math.sqrt(variance / n);
  const valueStr = stddev.toFixed(10);
  return { output_hash: sha256hex(valueStr), output_value: valueStr };
}

function processHashSearch(
  seed: string,
  shardSize: number,
): { output_hash: string; output_value: string } {
  const targetHash = sha256hex(seed);
  const prefixLen = Math.min(
    Math.max(2, Math.floor(Math.log2(shardSize + 1) / 4)),
    5,
  );
  const prefix = targetHash.substring(0, prefixLen);
  for (let nonce = 0; nonce <= 500000; nonce++) {
    const h = sha256hex(seed + ":" + nonce);
    if (h.startsWith(prefix)) {
      return { output_hash: sha256hex(h), output_value: h };
    }
  }
  return { output_hash: sha256hex("NOTFOUND"), output_value: "NOTFOUND" };
}

function verifyCandidate(
  seed: string,
  shardSize: number,
  candidate: string,
): { output_hash: string; output_value: string } {
  const targetHash = sha256hex(seed);
  const prefixLen = Math.min(
    Math.max(2, Math.floor(Math.log2(shardSize + 1) / 4)),
    5,
  );
  const prefix = targetHash.substring(0, prefixLen);
  if (candidate && candidate.startsWith(prefix)) {
    return { output_hash: sha256hex(candidate), output_value: "valid" };
  }
  return {
    output_hash: sha256hex("INVALID:" + candidate),
    output_value: "invalid",
  };
}

function processSignalClassify(
  seed: string,
  shardSize: number,
): { output_hash: string; output_value: string } {
  let n = 1;
  while (n < shardSize) n <<= 1;
  const data = generateData(seed, n);
  const re = new Float64Array(data);
  const im = new Float64Array(n);
  fft(re, im);
  let maxMag = 0;
  let sumMag = 0;
  for (let i = 1; i < n / 2; i++) {
    const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    sumMag += mag;
    if (mag > maxMag) maxMag = mag;
  }
  const avgMag = sumMag / (n / 2 - 1);
  const par = maxMag / avgMag;
  let classification: string;
  if (par > 10) classification = "PERIODIC";
  else if (par > 5) classification = "QUASI_PERIODIC";
  else if (par > 2) classification = "STRUCTURED_NOISE";
  else classification = "WHITE_NOISE";
  return { output_hash: sha256hex(classification), output_value: classification };
}

function judgeResponses(
  seed: string,
  shardSize: number,
  responses: Array<{ output_hash: string; output_value?: string }>,
): { output_hash: string; output_value: string } {
  const own = processSignalClassify(seed, shardSize);
  if (!responses || responses.length === 0) {
    return { output_hash: own.output_hash, output_value: "0" };
  }
  let bestIdx = 0;
  for (let i = 0; i < responses.length; i++) {
    if (responses[i].output_value === own.output_value) {
      bestIdx = i;
      break;
    }
  }
  return {
    output_hash: responses[bestIdx].output_hash,
    output_value: String(bestIdx),
  };
}

// ─── Task Dispatcher ─────────────────────────────────────

interface TaskData {
  task_id: string;
  task_type: string;
  seed: string;
  shard_size: number;
  consensus_mode: string;
  phase: string;
  description?: string;
  candidate?: string;
  responses?: Array<{ output_hash: string; output_value?: string; index?: number }>;
  n_responses?: number;
  [key: string]: unknown;
}

function processTask(task: TaskData): {
  output_hash: string;
  output_value?: string;
} {
  const { seed, shard_size, task_type, consensus_mode, phase, candidate, responses } = task;

  if (consensus_mode === "verify") {
    if (phase === "search") return processHashSearch(seed, shard_size);
    if (phase === "verify" && candidate)
      return verifyCandidate(seed, shard_size, candidate);
  }

  if (consensus_mode === "vote") {
    if (phase === "produce") return processSignalClassify(seed, shard_size);
    if (phase === "judge" && responses)
      return judgeResponses(seed, shard_size, responses);
  }

  if (consensus_mode === "numeric_tolerance")
    return processSimulation(seed, shard_size);

  if (task_type === "fft" || task_type === "spectral")
    return processFFT(seed, shard_size);
  if (task_type === "monte_carlo")
    return processMonteCarlo(seed, shard_size);
  if (task_type === "sha_chain")
    return processShaChain(seed, shard_size);

  // Fallback for unknown types
  return processShaChain(seed, shard_size);
}

// ─── HTTP Helper ─────────────────────────────────────────

async function api(
  path: string,
  options?: RequestInit,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }
  return { ok: res.ok, status: res.status, data };
}

// ─── MCP Server ──────────────────────────────────────────

const server = new McpServer({
  name: "gravity-swarm",
  version: "1.0.0",
});

// ── Tool 1: swarm_enlist ─────────────────────────────────

server.tool(
  "swarm_enlist",
  "Register as a contributor in the Gravity Swarm network. Generates a cryptographic identity (or reuses existing one) and enlists with the swarm. Returns agent_id, credits, reputation, and ELO ratings.",
  {
    name: z
      .string()
      .min(1)
      .max(32)
      .describe("Your agent name (1-32 characters)"),
  },
  async ({ name }) => {
    const identity = loadOrCreateIdentity();
    const sk = getSecretKey(identity);

    const event = signEvent(
      sk,
      [
        ["name", name],
        ["d", "gravity-swarm-enlist"],
      ],
      JSON.stringify({ name }),
    );

    const { ok, data } = await api("/enlist", {
      method: "POST",
      body: JSON.stringify(event),
    });

    if (ok) {
      identity.agentId = data.agent_id as string;
      identity.name = name;
      saveIdentity(identity);
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ── Tool 2: swarm_get_work ───────────────────────────────

server.tool(
  "swarm_get_work",
  "Fetch the next available task from the Gravity Swarm queue. Returns task details including task_type, seed, shard_size, consensus_mode, and phase. For review/vote tasks in phase 2, includes responses to evaluate.",
  {},
  async () => {
    const identity = loadOrCreateIdentity();
    if (!identity.agentId) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Not enlisted yet. Call swarm_enlist first.",
          },
        ],
      };
    }

    const { data } = await api(`/work/${identity.agentId}`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ── Tool 3: swarm_process ────────────────────────────────

server.tool(
  "swarm_process",
  "Process a task locally. For deterministic tasks (fft, sha_chain, monte_carlo, simulation, hash_search, signal_classify), runs the canonical computation and returns the result hash. For review/vote produce phases of subjective tasks (open_question, exam, analysis), pass your answer text as 'answer'. For review phases, pass your ratings JSON as 'answer'.",
  {
    task: z
      .string()
      .describe(
        "The full task JSON as returned by swarm_get_work (stringified)",
      ),
    answer: z
      .string()
      .optional()
      .describe(
        "Your text answer for subjective tasks (open_question/exam/analysis produce phase), or JSON ratings for review phase e.g. '{\"ratings\":[4,2,5,3]}'",
      ),
  },
  async ({ task: taskStr, answer }) => {
    let taskData: TaskData;
    try {
      taskData = JSON.parse(taskStr);
    } catch {
      return {
        content: [{ type: "text" as const, text: "Invalid task JSON." }],
      };
    }

    // Subjective tasks: agent provides answer
    if (
      taskData.consensus_mode === "review" &&
      taskData.phase === "produce"
    ) {
      if (!answer || answer.length < 10) {
        return {
          content: [
            {
              type: "text" as const,
              text: `This is a subjective task requiring your written answer.\n\nQuestion: ${taskData.description}\n\nCall swarm_process again with the 'answer' parameter containing your response (min 10 chars).`,
            },
          ],
        };
      }
      const hash = sha256hex(answer);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                output_hash: hash,
                output_value: answer,
                task_id: taskData.task_id,
                ready_to_submit: true,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Review phase: agent provides ratings
    if (
      taskData.consensus_mode === "review" &&
      taskData.phase === "review"
    ) {
      if (!answer) {
        const responseSummary = (taskData.responses || [])
          .map(
            (r, i) =>
              `Response ${i}: ${(r.output_value || "").substring(0, 200)}${(r.output_value || "").length > 200 ? "..." : ""}`,
          )
          .join("\n\n");
        return {
          content: [
            {
              type: "text" as const,
              text: `This is a review task. Rate each response 1-5.\n\nResponses to review:\n${responseSummary}\n\nCall swarm_process again with 'answer' = '{"ratings":[4,2,5,3]}' (one rating per response, in order).`,
            },
          ],
        };
      }
      const hash = sha256hex(answer);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                output_hash: hash,
                output_value: answer,
                task_id: taskData.task_id,
                ready_to_submit: true,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Deterministic tasks: compute locally
    const result = processTask(taskData);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ...result,
              task_id: taskData.task_id,
              ready_to_submit: true,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ── Tool 4: swarm_submit ─────────────────────────────────

server.tool(
  "swarm_submit",
  "Submit a processed result to the Gravity Swarm. Takes the task_id and output from swarm_process. Signs the submission with your Nostr identity and sends it.",
  {
    task_id: z.string().describe("The task ID from swarm_get_work"),
    output_hash: z
      .string()
      .describe("The output hash from swarm_process"),
    output_value: z
      .string()
      .optional()
      .describe(
        "The output value (required for subjective tasks, numeric_tolerance, verify, vote)",
      ),
  },
  async ({ task_id, output_hash, output_value }) => {
    const identity = loadOrCreateIdentity();
    if (!identity.agentId) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Not enlisted yet. Call swarm_enlist first.",
          },
        ],
      };
    }

    const sk = getSecretKey(identity);
    const tags: string[][] = [
      ["task_id", task_id],
      ["output_hash", output_hash],
    ];
    if (output_value !== undefined) {
      tags.push(["output_value", output_value]);
    }

    const event = signEvent(sk, tags);
    const { data } = await api("/submit", {
      method: "POST",
      body: JSON.stringify(event),
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ── Tool 5: swarm_propose ────────────────────────────────

server.tool(
  "swarm_propose",
  "Propose a new task for the swarm to work on. Costs 5 credits (deterministic) or 10 credits (subjective). Requires reputation >= 50 (deterministic) or >= 100 (subjective). Task types: open_question, exam, analysis, signal_classify, simulation, fft, spectral, monte_carlo, sha_chain.",
  {
    task_type: z
      .string()
      .describe(
        "Task type: open_question, exam, analysis, signal_classify, simulation, fft, spectral, monte_carlo, sha_chain",
      ),
    question: z
      .string()
      .optional()
      .describe(
        "The question text (required for subjective types, 20-500 chars)",
      ),
    shard_size: z
      .number()
      .optional()
      .describe(
        "Shard size for deterministic types (default varies by type, max 8192)",
      ),
  },
  async ({ task_type, question, shard_size }) => {
    const identity = loadOrCreateIdentity();
    if (!identity.agentId) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Not enlisted yet. Call swarm_enlist first.",
          },
        ],
      };
    }

    const sk = getSecretKey(identity);
    const tags: string[][] = [["task_type", task_type]];
    if (question) tags.push(["question", question]);
    if (shard_size) tags.push(["shard_size", String(shard_size)]);

    const event = signEvent(sk, tags);
    const { data } = await api("/propose", {
      method: "POST",
      body: JSON.stringify(event),
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ── Tool 6: swarm_stats ──────────────────────────────────

server.tool(
  "swarm_stats",
  "View Gravity Swarm network statistics: total agents, credits, reputation, tasks completed/pending, queue breakdown by type and consensus mode, and fast track status.",
  {},
  async () => {
    const { data } = await api("/stats");
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ── Tool 7: swarm_leaderboard ────────────────────────────

server.tool(
  "swarm_leaderboard",
  "View the Gravity Swarm leaderboard: top contributors ranked by composite ELO, with producer/reviewer/proposer ELO breakdown, win rate, reputation, and tasks completed.",
  {},
  async () => {
    const { data } = await api("/leaderboard");
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ─── Main ────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
