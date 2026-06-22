import type { TicketEvent } from "./api.js";

export const ADDRESS_PR_REVIEWS_ACTIVE_ICON = "⏳";
export const ADDRESS_PR_REVIEWS_IDLE_ICON = "💬";

const TERMINAL_ADDRESS_PR_REVIEW_MESSAGES = [
  "Address PR comments failed:",
  "Addressed PR comments",
  "No PR review comments to address.",
];

export function isAddressingPrReviews(
  ticketId: string,
  addressingPrTicketIds: readonly string[],
  locallyRequestedTicketId: string | null,
): boolean {
  return locallyRequestedTicketId === ticketId || addressingPrTicketIds.includes(ticketId);
}

export function addressPrReviewsIcon(
  ticketId: string,
  addressingPrTicketIds: readonly string[],
  locallyRequestedTicketId: string | null,
): string {
  return isAddressingPrReviews(ticketId, addressingPrTicketIds, locallyRequestedTicketId)
    ? ADDRESS_PR_REVIEWS_ACTIVE_ICON
    : ADDRESS_PR_REVIEWS_IDLE_ICON;
}

export function hasTerminalAddressPrReviewEvent(events: readonly TicketEvent[], ticketId: string): boolean {
  return events.some(
    (event) =>
      event.ticketId === ticketId &&
      TERMINAL_ADDRESS_PR_REVIEW_MESSAGES.some((message) => event.message.startsWith(message)),
  );
}
