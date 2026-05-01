const fs = require("node:fs/promises");

const RUBRIC_DIMENSIONS = [
  "Contract coverage",
  "Correctness risk",
  "Verification evidence",
  "Docs/state parity",
];

const REVIEWER_REQUIRED_FIELDS = [
  "MISSION ANCHOR",
  "Remaining contract IDs",
  "Findings",
  "Acceptable as-is",
  "Smallest follow-up slice",
];

const AUDITOR_REQUIRED_FIELDS = [
  "MISSION ANCHOR",
  "Remaining contract IDs",
  "Why the project is still not done",
  "Open top-level contract IDs",
  "Blocker count",
  "High-value gap count",
  "Tracked and unignored worktree is clean",
  "Worktree blockers",
  "Next mandatory slice",
  "Stale or conflicting canonical state",
  "Plan truthfully captures remaining slice backlog",
];

const STOP_JUDGE_REQUIRED_FIELDS = [
  "MISSION ANCHOR",
  "Remaining contract IDs",
  "Can the project stop now",
  "Exact remaining open top-level contract IDs",
  "Blocker count",
  "High-value gap count",
  "Latest completed slice commit",
  "Docs/config/runbooks match shipped behavior",
  "Tracked and unignored worktree is clean",
  "Brief justification",
];

function asString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseReportFields(text) {
  const fields = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const normalized = line.replace(/^-\s*/, "").replace(/^`/, "").replace(/`$/, "");
    const match = normalized.match(/^([A-Za-z][A-Za-z0-9 _\/-]*?):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    fields[key.trim()] = value.trim();
  }
  return fields;
}

function parseYesNo(value) {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("yes")) return true;
  if (normalized.startsWith("no")) return false;
  return undefined;
}

function parseFirstNumber(value) {
  if (!value) return undefined;
  const match = value.match(/-?\d+/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rubricVerdicts(reportFields) {
  return RUBRIC_DIMENSIONS.map((dimension) => {
    const value = reportFields[dimension];
    const match = typeof value === "string" ? value.match(/^(pass|concern|fail)\s*-\s*(.+)$/i) : undefined;
    return {
      dimension,
      verdict: match?.[1]?.toLowerCase(),
      explanation: match?.[2]?.trim(),
      raw: value,
    };
  });
}

function validateRequiredFields(reportFields, requiredFields, errors, role) {
  for (const field of requiredFields) {
    if (!(field in reportFields)) {
      errors.push(`Missing required ${role} field: ${field}.`);
      continue;
    }
    const value = reportFields[field];
    if (field === "Rubric") continue;
    if (typeof value !== "string") {
      errors.push(`Malformed ${role} field: ${field}.`);
      continue;
    }
    if (field === "Findings") continue;
    if (value.trim().length === 0) {
      errors.push(`Empty required ${role} field: ${field}.`);
    }
  }
}

function validateYesNoField(reportFields, field, errors, message) {
  const parsed = parseYesNo(reportFields[field]);
  if (parsed === undefined) errors.push(message);
  return parsed;
}

function validateRoleReport(role, output, reportFields = parseReportFields(output)) {
  const errors = [];
  if (!asString(output)) {
    errors.push(`Empty ${role} report output.`);
    return { valid: false, errors, reportFields, rubric: [] };
  }
  if (!/^Rubric:\s*$/m.test(output)) {
    errors.push(`Missing Rubric heading for ${role}.`);
  }
  const rubric = rubricVerdicts(reportFields);
  for (const line of rubric) {
    if (!line.raw) {
      errors.push(`Missing rubric line for ${role}: ${line.dimension}.`);
      continue;
    }
    if (!line.verdict || !line.explanation) {
      errors.push(`Malformed rubric line for ${role}: ${line.dimension}. Expected pass|concern|fail - explanation.`);
    }
  }
  const anyFail = rubric.some((line) => line.verdict === "fail");

  if (role === "completion-reviewer") {
    validateRequiredFields(reportFields, REVIEWER_REQUIRED_FIELDS, errors, role);
    const acceptable = parseYesNo(reportFields["Acceptable as-is"]);
    if (acceptable === undefined) errors.push("Reviewer output must answer 'Acceptable as-is' with yes or no.");
    if (anyFail && acceptable === true) {
      errors.push("Reviewer output cannot mark 'Acceptable as-is: yes' when any rubric line is fail.");
    }
    if (acceptable === false && !asString(reportFields["Smallest follow-up slice"])) {
      errors.push("Reviewer output must include a smallest follow-up slice when acceptance is no.");
    }
  } else if (role === "completion-auditor") {
    validateRequiredFields(reportFields, AUDITOR_REQUIRED_FIELDS, errors, role);
    if (parseFirstNumber(reportFields["Blocker count"]) === undefined) {
      errors.push("Auditor output must include a numeric Blocker count.");
    }
    if (parseFirstNumber(reportFields["High-value gap count"]) === undefined) {
      errors.push("Auditor output must include a numeric High-value gap count.");
    }
    validateYesNoField(
      reportFields,
      "Tracked and unignored worktree is clean",
      errors,
      "Auditor output must answer 'Tracked and unignored worktree is clean' with yes or no.",
    );
    validateYesNoField(
      reportFields,
      "Stale or conflicting canonical state",
      errors,
      "Auditor output must answer 'Stale or conflicting canonical state' with yes or no.",
    );
    validateYesNoField(
      reportFields,
      "Plan truthfully captures remaining slice backlog",
      errors,
      "Auditor output must answer 'Plan truthfully captures remaining slice backlog' with yes or no.",
    );
  } else if (role === "completion-stop-judge") {
    validateRequiredFields(reportFields, STOP_JUDGE_REQUIRED_FIELDS, errors, role);
    const canStop = validateYesNoField(
      reportFields,
      "Can the project stop now",
      errors,
      "Stop-judge output must answer 'Can the project stop now' with yes or no.",
    );
    if (anyFail && canStop === true) {
      errors.push("Stop-judge output cannot mark 'Can the project stop now: yes' when any rubric line is fail.");
    }
    if (parseFirstNumber(reportFields["Blocker count"]) === undefined) {
      errors.push("Stop-judge output must include a numeric Blocker count.");
    }
    if (parseFirstNumber(reportFields["High-value gap count"]) === undefined) {
      errors.push("Stop-judge output must include a numeric High-value gap count.");
    }
    validateYesNoField(
      reportFields,
      "Docs/config/runbooks match shipped behavior",
      errors,
      "Stop-judge output must answer 'Docs/config/runbooks match shipped behavior' with yes or no.",
    );
    validateYesNoField(
      reportFields,
      "Tracked and unignored worktree is clean",
      errors,
      "Stop-judge output must answer 'Tracked and unignored worktree is clean' with yes or no.",
    );
  }

  return { valid: errors.length === 0, errors, reportFields, rubric };
}

async function readJsonl(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function appendJsonlRecord(filePath, record) {
  await fs.mkdir(require("node:path").dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function transcribeCanonicalRoleReport({ role, output, reportFields = parseReportFields(output), snapshotFiles, headSha, sliceId, recordedAt = Date.now() }) {
  const result = { appended: [], skipped: [], errors: [] };

  if (!snapshotFiles || !headSha) {
    result.errors.push("Missing canonical snapshot files or git HEAD for transcription.");
    return result;
  }

  if (role === "completion-reviewer" || role === "completion-auditor" || role === "completion-stop-judge") {
    const validation = validateRoleReport(role, output, reportFields);
    if (!validation.valid) {
      result.errors.push(...validation.errors);
      return result;
    }
  }

  if (role === "completion-reviewer" || role === "completion-auditor") {
    if (!sliceId) {
      result.errors.push(`Missing slice_id for ${role} transcription.`);
      return result;
    }
    const type = role === "completion-reviewer" ? "reviewed" : "audited";
    const history = await readJsonl(snapshotFiles.sliceHistoryPath);
    const duplicate = history.some((entry) => {
      return entry.type === type && entry.slice_id === sliceId && entry.head_sha === headSha && entry.report_text === output.trim();
    });
    if (duplicate) {
      result.skipped.push(`Skipped duplicate ${type} record for slice ${sliceId} at ${headSha.slice(0, 12)}.`);
      return result;
    }
    await appendJsonlRecord(snapshotFiles.sliceHistoryPath, {
      schema_version: 1,
      type,
      recorded_at: recordedAt,
      slice_id: sliceId,
      commit_sha: headSha,
      head_sha: headSha,
      role,
      report_fields: reportFields,
      report_text: output.trim(),
    });
    result.appended.push(`${type}:${sliceId}`);
    return result;
  }

  if (role === "completion-stop-judge") {
    const canStop = parseYesNo(reportFields["Can the project stop now"]);
    const blockerCount = parseFirstNumber(reportFields["Blocker count"]);
    const highValueGapCount = parseFirstNumber(reportFields["High-value gap count"]);
    if (canStop === undefined || blockerCount === undefined || highValueGapCount === undefined) {
      result.errors.push("Missing required stop-judge fields for canonical judgment transcription.");
      return result;
    }
    const history = await readJsonl(snapshotFiles.stopHistoryPath);
    const duplicate = history.some((entry) => {
      return entry.type === "judgment" && entry.head_sha === headSha && entry.report_text === output.trim();
    });
    if (duplicate) {
      result.skipped.push(`Skipped duplicate judgment record at ${headSha.slice(0, 12)}.`);
      return result;
    }
    await appendJsonlRecord(snapshotFiles.stopHistoryPath, {
      schema_version: 1,
      type: "judgment",
      recorded_at: recordedAt,
      head_sha: headSha,
      can_stop: canStop,
      blocker_count: blockerCount,
      high_value_gap_count: highValueGapCount,
      role,
      report_fields: reportFields,
      report_text: output.trim(),
    });
    result.appended.push(`judgment:${headSha.slice(0, 12)}`);
    return result;
  }

  if (role === "completion-regrounder") {
    const rawDecision = asString(reportFields["Reconciliation decision"])?.toLowerCase();
    const decision = rawDecision?.match(/\b(accepted|reopened|none)\b/)?.[1];
    if (!decision || decision === "none") {
      result.skipped.push("No reconciliation decision emitted by completion-regrounder.");
      return result;
    }
    const reconciledSliceId = asString(reportFields["Reconciled slice ID"]) ?? asString(reportFields["Current selected slice"]) ?? sliceId;
    if (!reconciledSliceId || reconciledSliceId === "none" || reconciledSliceId === "(none)") {
      result.errors.push("Missing reconciled slice id for completion-regrounder transcription.");
      return result;
    }
    const history = await readJsonl(snapshotFiles.sliceHistoryPath);
    const duplicate = history.some((entry) => {
      return entry.type === decision && entry.slice_id === reconciledSliceId && entry.head_sha === headSha && entry.report_text === output.trim();
    });
    if (duplicate) {
      result.skipped.push(`Skipped duplicate ${decision} record for slice ${reconciledSliceId} at ${headSha.slice(0, 12)}.`);
      return result;
    }
    await appendJsonlRecord(snapshotFiles.sliceHistoryPath, {
      schema_version: 1,
      type: decision,
      recorded_at: recordedAt,
      slice_id: reconciledSliceId,
      commit_sha: headSha,
      head_sha: headSha,
      role,
      report_fields: reportFields,
      report_text: output.trim(),
    });
    result.appended.push(`${decision}:${reconciledSliceId}`);
    return result;
  }

  result.skipped.push(`No automatic transcription configured for ${role}.`);
  return result;
}

module.exports = {
  RUBRIC_DIMENSIONS,
  parseReportFields,
  parseYesNo,
  parseFirstNumber,
  validateRoleReport,
  transcribeCanonicalRoleReport,
};
