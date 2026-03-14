/**
 * Cinematography Prompt Engineer
 * Client-side application — communicates directly with OpenAI API
 * No data is persisted server-side.
 */

"use strict";

// ──────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────

const state = {
  apiKey: "",
  videoFile: null,
  videoAnalysis: null,       // structured object from AI
  refImages: [null, null, null], // base64 data-URLs
  refAnalysis: null,
  prefix: "",
  scriptLines: [],
  generatedPrompts: [],      // array of strings
  refinedPrompts: [],
  selectedAdjustment: "",
};

// ──────────────────────────────────────────────────────────────────
// DOM helpers
// ──────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const show = (el) => { el.style.display = ""; };
const hide = (el) => { el.style.display = "none"; };

// ──────────────────────────────────────────────────────────────────
// Toast notifications
// ──────────────────────────────────────────────────────────────────

function toast(message, type = "info", duration = 3500) {
  const container = $("toastContainer");
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = message;
  container.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity 0.3s";
    setTimeout(() => t.remove(), 300);
  }, duration);
}

// ──────────────────────────────────────────────────────────────────
// API Key management
// ──────────────────────────────────────────────────────────────────

function loadApiKey() {
  try {
    const stored = sessionStorage.getItem("oai_key");
    if (stored) {
      state.apiKey = stored;
      updateApiIndicator(true);
    }
  } catch (_) { /* private browsing */ }
}

function saveApiKey(key) {
  state.apiKey = key.trim();
  try { sessionStorage.setItem("oai_key", state.apiKey); } catch (_) { /* */ }
  updateApiIndicator(!!state.apiKey);
}

function updateApiIndicator(connected) {
  const ind = $("apiIndicator");
  ind.classList.toggle("connected", connected);
  $("apiKeyBtn").textContent = connected ? "Change Key" : "Set API Key";
}

$("apiKeyBtn").addEventListener("click", () => {
  $("apiKeyInput").value = state.apiKey;
  $("apiModal").classList.add("open");
  setTimeout(() => $("apiKeyInput").focus(), 100);
});

$("apiModalCancel").addEventListener("click", () => {
  $("apiModal").classList.remove("open");
});

$("apiModalSave").addEventListener("click", () => {
  const val = $("apiKeyInput").value.trim();
  if (!val.startsWith("sk-")) {
    toast("Key should start with sk-", "error");
    return;
  }
  saveApiKey(val);
  $("apiModal").classList.remove("open");
  toast("API key saved for this session", "success");
});

$("apiKeyInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("apiModalSave").click();
  if (e.key === "Escape") $("apiModalCancel").click();
});

// ──────────────────────────────────────────────────────────────────
// Step navigation
// ──────────────────────────────────────────────────────────────────

let currentStep = 1;
const TOTAL_STEPS = 6;

function goToStep(n) {
  if (n < 1 || n > TOTAL_STEPS) return;
  document.querySelectorAll(".step-section").forEach((s) => s.classList.remove("active"));
  document.querySelectorAll(".step-item").forEach((item) => {
    const num = parseInt(item.dataset.step, 10);
    item.classList.remove("active", "completed");
    if (num === n) item.classList.add("active");
    if (num < n) item.classList.add("completed");
  });
  $(`step${n}`).classList.add("active");
  currentStep = n;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ──────────────────────────────────────────────────────────────────
// Step 1 — Video upload & analysis
// ──────────────────────────────────────────────────────────────────

const videoInput = $("videoFileInput");
const videoDropZone = $("videoDropZone");

videoDropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  videoDropZone.classList.add("drag-over");
});
videoDropZone.addEventListener("dragleave", () => videoDropZone.classList.remove("drag-over"));
videoDropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  videoDropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("video/")) handleVideoFile(file);
});

videoInput.addEventListener("change", () => {
  if (videoInput.files[0]) handleVideoFile(videoInput.files[0]);
});

function handleVideoFile(file) {
  state.videoFile = file;
  const url = URL.createObjectURL(file);
  const video = $("videoPreview");
  video.src = url;
  $("videoDropLabel").textContent = file.name;
  videoDropZone.classList.add("has-file");
  $("videoPreviewWrapper").classList.add("visible");

  video.addEventListener("loadeddata", () => extractFrames(video), { once: true });

  show($("videoAnalyzeRow"));
  $("step1Next").disabled = false;
}

async function extractFrames(videoEl) {
  const frameGrid = $("frameGrid");
  frameGrid.innerHTML = "";
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  const duration = videoEl.duration;
  if (!isFinite(duration) || duration === 0) return;

  // Extract up to 8 evenly-spaced frames
  const COUNT = 8;
  const times = [];
  for (let i = 0; i < COUNT; i++) {
    times.push((duration / (COUNT - 1)) * i);
  }

  for (const t of times) {
    await seekTo(videoEl, t);
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    ctx.drawImage(videoEl, 0, 0);
    const img = document.createElement("img");
    img.src = canvas.toDataURL("image/jpeg", 0.7);
    frameGrid.appendChild(img);
  }
}

function seekTo(video, time) {
  return new Promise((resolve) => {
    video.currentTime = time;
    video.addEventListener("seeked", resolve, { once: true });
  });
}

$("analyzeVideoBtn").addEventListener("click", analyzeVideo);

async function analyzeVideo() {
  if (!state.apiKey) {
    toast("Please set your OpenAI API key first", "error");
    $("apiKeyBtn").click();
    return;
  }

  const frameImgs = $("frameGrid").querySelectorAll("img");
  if (frameImgs.length === 0) {
    toast("No frames extracted yet — wait for video to load", "error");
    return;
  }

  // Collect up to 4 frames for analysis (keep token usage reasonable)
  const frames = [];
  const step = Math.max(1, Math.floor(frameImgs.length / 4));
  for (let i = 0; i < frameImgs.length; i += step) {
    if (frames.length < 4) frames.push(frameImgs[i].src);
  }

  const btn = $("analyzeVideoBtn");
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Analysing…';

  try {
    const result = await callVisionAPI(frames, buildVideoAnalysisPrompt());
    state.videoAnalysis = parseAnalysis(result);
    renderAnalysis($("videoAnalysisContent"), state.videoAnalysis);
    $("videoAnalysisBox").classList.add("visible");
    toast("Video analysis complete", "success");
  } catch (err) {
    toast(`Analysis failed: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
      </svg>
      Re-analyse Video`;
  }
}

function buildVideoAnalysisPrompt() {
  return `You are a professional cinematography analyst. Analyse these video frames and extract the visual language. 
Return ONLY a JSON object with exactly these keys (no markdown, no extra text):
{
  "shot_types": "comma-separated list of shot types observed",
  "camera_movement": "describe movement style",
  "camera_transitions": "how angles shift between cuts",
  "pacing": "average shot duration and rhythm",
  "lighting_style": "describe lighting precisely",
  "color_treatment": "describe palette in plain color terms, no mood words",
  "visual_tone": "overall tone in literal terms"
}
Rules:
- Do NOT use words: cinematic, dramatic, moody, ethereal, dreamlike, atmospheric, epic, stunning, beautiful, magical
- Be precise and literal
- Keep each value to 1-2 sentences maximum`;
}

// ──────────────────────────────────────────────────────────────────
// Step 2 — Reference images
// ──────────────────────────────────────────────────────────────────

document.querySelectorAll(".ref-file-input").forEach((input) => {
  input.addEventListener("change", () => handleRefImage(input));
});

document.querySelectorAll(".ref-image-slot .remove-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const slot = parseInt(btn.dataset.slot, 10);
    clearRefSlot(slot);
  });
});

function handleRefImage(input) {
  const slot = parseInt(input.dataset.slot, 10);
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    state.refImages[slot] = e.target.result;
    const slotEl = $(`refSlot${slot}`);
    slotEl.classList.add("filled");

    // Remove existing preview img if any
    const existing = slotEl.querySelector("img");
    if (existing) existing.remove();

    const img = document.createElement("img");
    img.src = e.target.result;
    slotEl.insertBefore(img, slotEl.querySelector(".slot-label"));
    slotEl.querySelector(".slot-label").style.display = "none";

    // Show analyse button if at least one image
    if (state.refImages.some(Boolean)) {
      show($("refAnalyzeRow"));
    }
  };
  reader.readAsDataURL(file);
}

function clearRefSlot(slot) {
  state.refImages[slot] = null;
  const slotEl = $(`refSlot${slot}`);
  slotEl.classList.remove("filled");
  const img = slotEl.querySelector("img");
  if (img) img.remove();
  slotEl.querySelector(".slot-label").style.display = "";
  slotEl.querySelector("input").value = "";

  if (!state.refImages.some(Boolean)) {
    hide($("refAnalyzeRow"));
  }
}

$("analyzeRefBtn").addEventListener("click", analyzeReferences);

async function analyzeReferences() {
  if (!state.apiKey) {
    toast("Please set your OpenAI API key first", "error");
    $("apiKeyBtn").click();
    return;
  }

  const images = state.refImages.filter(Boolean);
  if (images.length === 0) {
    toast("Please upload at least one reference image", "error");
    return;
  }

  const btn = $("analyzeRefBtn");
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Analysing…';

  try {
    const result = await callVisionAPI(images, buildRefAnalysisPrompt());
    state.refAnalysis = parseAnalysis(result);
    renderAnalysis($("refAnalysisContent"), state.refAnalysis);
    $("refAnalysisBox").classList.add("visible");
    toast("Reference analysis complete", "success");
  } catch (err) {
    toast(`Analysis failed: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
      </svg>
      Re-analyse References`;
  }
}

function buildRefAnalysisPrompt() {
  return `You are a professional visual style analyst. Analyse these reference images and extract style information.
Return ONLY a JSON object with exactly these keys (no markdown, no extra text):
{
  "color_palette": "describe the palette in plain color/tone terms",
  "lighting_quality": "describe lighting precisely",
  "subject_framing": "describe how subjects are positioned in frame",
  "background_complexity": "simple/medium/complex with brief description",
  "texture_style": "describe surface and texture qualities"
}
Rules:
- Do NOT use words: cinematic, dramatic, moody, ethereal, dreamlike, atmospheric, epic, stunning, beautiful, magical
- Be precise and literal, use actual color names where possible`;
}

// ──────────────────────────────────────────────────────────────────
// Step 3 — Prefix
// ──────────────────────────────────────────────────────────────────

document.querySelectorAll("#prefixChips .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    $("prefixInput").value = chip.dataset.prefix;
    document.querySelectorAll("#prefixChips .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    state.prefix = chip.dataset.prefix;
  });
});

$("prefixInput").addEventListener("input", () => {
  state.prefix = $("prefixInput").value;
  document.querySelectorAll("#prefixChips .chip").forEach((c) => c.classList.remove("active"));
});

// ──────────────────────────────────────────────────────────────────
// Step 4 — Script
// ──────────────────────────────────────────────────────────────────

const scriptInput = $("scriptInput");

scriptInput.addEventListener("input", updateLineCount);

function updateLineCount() {
  const lines = getScriptLines();
  $("lineCount").textContent = `${lines.length} line${lines.length !== 1 ? "s" : ""}`;
  $("step4Next").disabled = lines.length === 0;
}

function getScriptLines() {
  return scriptInput.value
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

$("clearScriptBtn").addEventListener("click", () => {
  scriptInput.value = "";
  updateLineCount();
});

// ──────────────────────────────────────────────────────────────────
// Step 5 — Prompt generation
// ──────────────────────────────────────────────────────────────────

async function generatePrompts() {
  const lines = getScriptLines();
  if (lines.length === 0) return;

  state.scriptLines = lines;

  if (!state.apiKey) {
    toast("Please set your OpenAI API key first", "error");
    $("apiKeyBtn").click();
    return;
  }

  goToStep(5);

  show($("generatingRow"));
  hide($("copyAllBar"));
  $("promptsList").innerHTML = "";
  $("step5Next").disabled = true;

  try {
    const prompts = await callPromptGenerationAPI(lines);
    state.generatedPrompts = prompts;
    renderPrompts($("promptsList"), prompts, state.scriptLines);
    $("promptsCountLabel").textContent = `${prompts.length} prompt${prompts.length !== 1 ? "s" : ""} generated`;
    show($("copyAllBar"));
    $("step5Next").disabled = false;
  } catch (err) {
    toast(`Generation failed: ${err.message}`, "error", 6000);
  } finally {
    hide($("generatingRow"));
  }
}

function buildSystemPrompt() {
  const parts = [
    "You are a professional cinematography analyst and AI image prompt engineer.",
    "Generate one image prompt per script line, following these rules EXACTLY.\n",
    "FORMAT for each prompt (plain prose, no bullet points):",
    "[User prefix]. [Shot type + camera angle]. [Subject action + position in frame]. [Background — max 4 words]. [Lighting — one clean descriptor]. [Color palette — plain color/tone terms].\n",
    "ALWAYS INCLUDE:",
    "- The user's custom prefix verbatim (first)",
    "- Shot type and camera angle",
    "- Subject: what they're doing, their position in frame",
    "- Background: 2-4 words only",
    "- Lighting: one descriptor (e.g. soft side light from left, overcast diffused light)",
    "- Color palette: actual colors or tones\n",
    "NEVER USE these words: cinematic, dramatic, moody, ethereal, dreamlike, atmospheric, epic, stunning, beautiful, magical, film grain, bokeh, golden hour, gradient, color grading, teal and orange, depth of field blur, lens flare, vignette\n",
    "LIMITS: max 3 descriptors per element. Keep each prompt to 2-3 sentences max.\n",
  ];

  if (state.videoAnalysis) {
    parts.push("VIDEO VISUAL LANGUAGE (match this aesthetic):");
    Object.entries(state.videoAnalysis).forEach(([k, v]) => {
      parts.push(`- ${k.replace(/_/g, " ")}: ${v}`);
    });
    parts.push("");
  }

  if (state.refAnalysis) {
    parts.push("REFERENCE IMAGE STYLE (anchor all prompts to this):");
    Object.entries(state.refAnalysis).forEach(([k, v]) => {
      parts.push(`- ${k.replace(/_/g, " ")}: ${v}`);
    });
    parts.push("");
  }

  const prefix = state.prefix || "Realistic photograph,";
  parts.push(`USER PREFIX (prepend verbatim to every prompt): "${prefix}"`);

  return parts.join("\n");
}

async function callPromptGenerationAPI(lines) {
  const systemPrompt = buildSystemPrompt();
  const prefix = state.prefix || "Realistic photograph,";

  const userMessage = `Generate one image prompt per script line below. 
Return a JSON array of strings — one string per prompt, numbered [1], [2], etc. at the start.
Each prompt MUST start with: ${prefix}

Script lines:
${lines.map((l, i) => `[${i + 1}] ${l}`).join("\n")}`;

  const response = await fetchOpenAI({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.4,
    max_tokens: 200 * lines.length,
  });

  const text = response.choices[0].message.content.trim();
  return parsePromptsResponse(text, lines.length);
}

function parsePromptsResponse(text, expectedCount) {
  // Try to extract JSON array first
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]);
      if (Array.isArray(arr) && arr.length > 0) return arr.map(String);
    } catch (_) { /* fall through */ }
  }

  // Fallback: split by numbered lines [1], [2], …
  const prompts = [];
  const numbered = text.split(/\[\d+\]/);
  for (let i = 1; i < numbered.length; i++) {
    const p = numbered[i].trim().replace(/^[\n\r]+/, "");
    if (p) prompts.push(`[${i}]\n${p}`);
  }
  if (prompts.length > 0) return prompts;

  // Last resort: split by double newline
  const chunks = text.split(/\n{2,}/).filter((c) => c.trim());
  return chunks.slice(0, expectedCount);
}

// ──────────────────────────────────────────────────────────────────
// Step 6 — Refinement
// ──────────────────────────────────────────────────────────────────

document.querySelectorAll("#adjustmentChips .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#adjustmentChips .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    state.selectedAdjustment = chip.dataset.adjust;
    $("customAdjust").value = "";
    $("applyAdjustBtn").disabled = false;
  });
});

$("customAdjust").addEventListener("input", () => {
  const val = $("customAdjust").value.trim();
  $("applyAdjustBtn").disabled = !val;
  if (val) {
    document.querySelectorAll("#adjustmentChips .chip").forEach((c) => c.classList.remove("active"));
    state.selectedAdjustment = val;
  }
});

$("applyAdjustBtn").addEventListener("click", applyRefinement);

async function applyRefinement() {
  const adjustment = $("customAdjust").value.trim() || state.selectedAdjustment;
  if (!adjustment) return;

  if (!state.apiKey) {
    toast("Please set your OpenAI API key first", "error");
    $("apiKeyBtn").click();
    return;
  }

  const prompts = state.generatedPrompts;
  if (prompts.length === 0) {
    toast("No prompts to refine", "error");
    return;
  }

  show($("refineGeneratingRow"));
  $("applyAdjustBtn").disabled = true;
  hide($("refinedPromptsOutput"));

  try {
    const refined = await callRefinementAPI(prompts, adjustment);
    state.refinedPrompts = refined;
    renderPrompts($("refinedPromptsList"), refined, state.scriptLines);
    $("refinedCountLabel").textContent = `${refined.length} refined prompt${refined.length !== 1 ? "s" : ""}`;
    show($("refinedPromptsOutput"));
    toast("Refinement applied", "success");
  } catch (err) {
    toast(`Refinement failed: ${err.message}`, "error", 6000);
  } finally {
    hide($("refineGeneratingRow"));
    $("applyAdjustBtn").disabled = false;
  }
}

async function callRefinementAPI(prompts, adjustment) {
  const systemPrompt = buildSystemPrompt();

  const userMessage = `Here are the existing image prompts:
${prompts.map((p, i) => `[${i + 1}] ${p}`).join("\n\n")}

Apply this adjustment: "${adjustment}"

Return a JSON array of strings — the revised prompts in the same order.
Maintain the same format and all original rules. Keep the user prefix on every prompt.`;

  const response = await fetchOpenAI({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.35,
    max_tokens: 200 * prompts.length,
  });

  const text = response.choices[0].message.content.trim();
  return parsePromptsResponse(text, prompts.length);
}

// ──────────────────────────────────────────────────────────────────
// Rendering helpers
// ──────────────────────────────────────────────────────────────────

function renderPrompts(container, prompts, lines) {
  container.innerHTML = "";
  prompts.forEach((text, i) => {
    const scene = lines[i] || `Scene ${i + 1}`;
    const block = document.createElement("div");
    block.className = "prompt-block";
    block.innerHTML = `
      <div class="prompt-block-header">
        <span class="prompt-num">[${i + 1}]</span>
        <span class="prompt-scene">${escapeHtml(scene)}</span>
        <button class="copy-btn" title="Copy prompt">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
          Copy
        </button>
      </div>
      <pre class="prompt-text">${escapeHtml(text)}</pre>`;

    block.querySelector(".copy-btn").addEventListener("click", () => {
      copyText(text, block.querySelector(".copy-btn"));
    });

    container.appendChild(block);
  });
}

function renderAnalysis(container, analysis) {
  container.innerHTML = "";
  Object.entries(analysis).forEach(([key, val]) => {
    const keyEl = document.createElement("div");
    keyEl.className = "prop-key";
    keyEl.textContent = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    const valEl = document.createElement("div");
    valEl.className = "prop-val";
    valEl.textContent = val;

    container.appendChild(keyEl);
    container.appendChild(valEl);
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ──────────────────────────────────────────────────────────────────
// Copy to clipboard
// ──────────────────────────────────────────────────────────────────

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
      btn.classList.add("copied");
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.classList.remove("copied");
      }, 2000);
    }
    toast("Copied to clipboard", "success");
  } catch (_) {
    toast("Copy failed — please select text manually", "error");
  }
}

$("copyAllBtn").addEventListener("click", () => {
  const all = state.generatedPrompts.join("\n\n---\n\n");
  copyText(all, $("copyAllBtn"));
});

$("copyRefinedAllBtn").addEventListener("click", () => {
  const all = state.refinedPrompts.join("\n\n---\n\n");
  copyText(all, $("copyRefinedAllBtn"));
});

// ──────────────────────────────────────────────────────────────────
// OpenAI API calls
// ──────────────────────────────────────────────────────────────────

async function fetchOpenAI(body) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err.error?.message || `HTTP ${response.status}`;
    throw new Error(msg);
  }

  return response.json();
}

async function callVisionAPI(imageDataUrls, textPrompt) {
  const imageContent = imageDataUrls.map((url) => ({
    type: "image_url",
    image_url: { url, detail: "low" },
  }));

  const response = await fetchOpenAI({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          ...imageContent,
          { type: "text", text: textPrompt },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 600,
  });

  return response.choices[0].message.content.trim();
}

function parseAnalysis(raw) {
  // Strip markdown code fences if present
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Return as single object with raw text
    return { analysis: raw };
  }
}

// ──────────────────────────────────────────────────────────────────
// Navigation wiring
// ──────────────────────────────────────────────────────────────────

// Step 1
$("step1Skip").addEventListener("click", () => goToStep(2));
$("step1Next").addEventListener("click", () => goToStep(2));

// Step 2
$("step2Back").addEventListener("click", () => goToStep(1));
$("step2Skip").addEventListener("click", () => goToStep(3));
$("step2Next").addEventListener("click", () => goToStep(3));

// Step 3
$("step3Back").addEventListener("click", () => goToStep(2));
$("step3Next").addEventListener("click", () => {
  state.prefix = $("prefixInput").value.trim() || "Realistic photograph,";
  goToStep(4);
});

// Step 4
$("step4Back").addEventListener("click", () => goToStep(3));
$("step4Next").addEventListener("click", () => generatePrompts());

// Step 5
$("step5Back").addEventListener("click", () => goToStep(4));
$("step5Next").addEventListener("click", () => goToStep(6));

// Step 6
$("step6Back").addEventListener("click", () => goToStep(5));
$("startOverBtn").addEventListener("click", () => {
  if (confirm("Start over? All progress will be cleared.")) {
    location.reload();
  }
});

// ──────────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────────

loadApiKey();
updateLineCount();
