const test = require("node:test");
const assert = require("node:assert/strict");
const { getRestrictionType } = require("../parking-sign-classification");

test("classifies an all-time no-parking sign", () => {
  assert.equal(
    getRestrictionType([{ description: "NO PARKING ANYTIME -->" }]),
    "no_parking",
  );
});

test("classifies an all-time no-standing sign", () => {
  assert.equal(
    getRestrictionType([{ description: "NO STANDING ANYTIME" }]),
    "no_standing",
  );
});

test("keeps scheduled sanitation no-parking signs in other", () => {
  assert.equal(
    getRestrictionType([{
      description: "NO PARKING (SANITATION BROOM SYMBOL) MONDAY THURSDAY 9AM-10:30AM",
      code: "PS-113B",
    }]),
    "other",
  );
});

test("keeps time-restricted no-parking signs in other", () => {
  assert.equal(
    getRestrictionType([{ description: "NO PARKING MONDAY-FRIDAY 8AM-6PM" }]),
    "other",
  );
});

test("classifies grouped panels individually and prioritizes no standing anytime", () => {
  assert.equal(
    getRestrictionType([
      { description: "NO PARKING (SANITATION BROOM SYMBOL) MONDAY 9AM-10AM" },
      { description: "NO STANDING ANYTIME" },
    ]),
    "no_standing",
  );
});
