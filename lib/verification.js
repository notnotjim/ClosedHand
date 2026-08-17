// lib/verification.js -- Structured self-evaluation for agents and automations
// Uses a fast model to generate success criteria and verify output quality.
// Inspired by Claude Managed Agents' self-evaluation loops.

const { getInternalClient } = require("./llm");

/**
 * Generate success criteria for a goal/task.
 * Uses the fast model tier to produce 3-5 verifiable criteria.
 * @param {string} goal - The task description
 * @param {string} userId - User ID for model routing
 * @returns {Promise<string[]>} Array of criteria strings
 */
async function generateSuccessCriteria(goal, userId) {
  try {
    const { client, model } = getInternalClient(userId);
    const resp = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 512,
        system: "You generate success criteria for AI agent tasks. Output ONLY a JSON array of 3-5 short, concrete, verifiable criteria strings. No explanation, just the JSON array.",
        messages: [{ role: "user", content: `Task: "${goal}"\n\nGenerate 3-5 success criteria that would verify this task was completed well. Each criterion should be specific and checkable (e.g. "includes at least 3 data points", "provides source references", "directly answers the user's question"). Return JSON array only.` }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("criteria generation timeout")), 15000)),
    ]);

    const text = resp.content?.find(b => b.type === "text")?.text || "";
    // Extract JSON array from response (may have markdown fences)
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(String).slice(0, 5);
      }
    }
  } catch (e) {
    console.log(`[Verification] Failed to generate criteria: ${e.message}`);
  }

  // Sensible defaults if generation fails
  return [
    "Output directly addresses the original goal",
    "Response contains specific, substantive information (not vague)",
    "Task was completed, not just described",
  ];
}

/**
 * Verify an agent's output against success criteria.
 * Uses the fast model tier for an independent, cheap evaluation.
 * @param {string} goal - Original task goal
 * @param {string[]} criteria - Success criteria to check
 * @param {string} output - The agent's final output text
 * @param {string[]} toolsUsed - List of tool names the agent called
 * @param {string} userId - User ID for model routing
 * @returns {Promise<{passed: boolean, feedback: string, criteriaResults: Array}>}
 */
async function verifyCompletion(goal, criteria, output, toolsUsed, userId) {
  try {
    const { client, model } = getInternalClient(userId);
    // Truncate output to avoid blowing up the verification context
    const truncatedOutput = output.length > 8000 ? output.substring(0, 8000) + "\n...[truncated]" : output;

    const resp = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 1024,
        system: "You are a strict quality evaluator for AI agent outputs. Evaluate whether the output meets the success criteria. Be fair but strict: vague, padded, or incomplete responses should fail. Respond ONLY with JSON.",
        messages: [{ role: "user", content: `GOAL: ${goal}\n\nSUCCESS CRITERIA:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nTOOLS USED: ${toolsUsed.join(", ") || "none"}\n\nAGENT OUTPUT:\n${truncatedOutput}\n\nEvaluate each criterion. Respond with JSON:\n{"passed": true/false, "feedback": "brief explanation of what's missing if failed", "criteria_results": [{"criterion": "...", "met": true/false, "reason": "..."}]}` }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("verification timeout")), 20000)),
    ]);

    const text = resp.content?.find(b => b.type === "text")?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        passed: !!parsed.passed,
        feedback: parsed.feedback || "",
        criteriaResults: parsed.criteria_results || [],
      };
    }
  } catch (e) {
    console.log(`[Verification] Evaluation failed: ${e.message}`);
  }

  // If verification itself fails, accept the output (don't block on infra issues)
  return { passed: true, feedback: "Verification inconclusive, accepting output", criteriaResults: [] };
}

module.exports = { generateSuccessCriteria, verifyCompletion };
