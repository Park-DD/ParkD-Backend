function classifySign(sign) {
  const ruleText = `${sign.description || ""} ${sign.code || ""}`
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  // Time-based sanitation rules are not equivalent to an all-day parking ban.
  if (/\bSANITATION\b|\bSTREET\s+CLEAN(?:ING)?\b/.test(ruleText)) {
    return "other";
  }
  if (/\bNO\s+STANDING\b.*\bANY\s*TIME\b/.test(ruleText)) {
    return "no_standing";
  }
  if (/\bNO\s+PARKING\b.*\bANY\s*TIME\b/.test(ruleText)) {
    return "no_parking";
  }
  return "other";
}

function getRestrictionType(signs) {
  const types = signs.map(classifySign);
  // A grouped location takes its strongest all-day restriction for map coloring.
  if (types.includes("no_standing")) {
    return "no_standing";
  }
  if (types.includes("no_parking")) {
    return "no_parking";
  }
  return "other";
}

module.exports = { getRestrictionType };
