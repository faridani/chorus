import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADDRESS_PR_REVIEWS_ACTIVE_ICON,
  ADDRESS_PR_REVIEWS_IDLE_ICON,
  addressPrReviewsIcon,
  hasTerminalAddressPrReviewEvent,
  isAddressingPrReviews,
} from "../src/addressPrReviews.js";
import type { TicketEvent } from "../src/api.js";

function ev(message: string, ticketId = "tkt_1"): TicketEvent {
  return {
    id: `${ticketId}-${message}`,
    projectId: "proj_1",
    ticketId,
    actor: "orchestrator",
    kind: "note",
    message,
    createdAt: Date.now(),
  };
}

test("Address PR Reviews uses the hourglass during local submit and server lifecycle", () => {
  assert.equal(isAddressingPrReviews("tkt_1", [], "tkt_1"), true);
  assert.equal(addressPrReviewsIcon("tkt_1", [], "tkt_1"), ADDRESS_PR_REVIEWS_ACTIVE_ICON);

  assert.equal(isAddressingPrReviews("tkt_1", ["tkt_1"], null), true);
  assert.equal(addressPrReviewsIcon("tkt_1", ["tkt_1"], null), ADDRESS_PR_REVIEWS_ACTIVE_ICON);

  assert.equal(isAddressingPrReviews("tkt_1", [], null), false);
  assert.equal(addressPrReviewsIcon("tkt_1", [], null), ADDRESS_PR_REVIEWS_IDLE_ICON);
});

test("Address PR Reviews local submit can clear on terminal lifecycle events", () => {
  assert.equal(hasTerminalAddressPrReviewEvent([ev("Addressed PR comments (pushed changes): fixed")], "tkt_1"), true);
  assert.equal(hasTerminalAddressPrReviewEvent([ev("Address PR comments failed: gh failed")], "tkt_1"), true);
  assert.equal(hasTerminalAddressPrReviewEvent([ev("No PR review comments to address.")], "tkt_1"), true);
  assert.equal(hasTerminalAddressPrReviewEvent([ev("Addressing PR review comments…")], "tkt_1"), false);
  assert.equal(hasTerminalAddressPrReviewEvent([ev("Addressed PR comments (no changes): reviewed")], "tkt_2"), false);
});
