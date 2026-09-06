import type { Ticket } from "./api.js";

export const TICKET_CLEANUP_CONFIRM_TEXT = "DELETE";

export interface TicketCleanupTargets {
  tickets: number;
  branchTickets: number;
  pullRequestTickets: number;
}

export function canConfirmTicketCleanup(input: string, ticketCount: number, busy = false): boolean {
  return !busy && ticketCount > 0 && input === TICKET_CLEANUP_CONFIRM_TEXT;
}

export function summarizeTicketCleanupTargets(tickets: Ticket[]): TicketCleanupTargets {
  return {
    tickets: tickets.length,
    branchTickets: tickets.filter(hasBranchCleanupTarget).length,
    pullRequestTickets: tickets.filter(hasPullRequestCleanupTarget).length,
  };
}

function hasBranchCleanupTarget(ticket: Ticket): boolean {
  return !!ticket.branch || ticket.tasks.some((task) => !!task.branch);
}

function hasPullRequestCleanupTarget(ticket: Ticket): boolean {
  return !!ticket.prUrl || ticket.prNumber != null;
}
