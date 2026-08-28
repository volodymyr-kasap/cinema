# 14. Zustand and React Hook Form are still not needed

**Status:** accepted (2026-08-28)

## Context

Phase 1's design document deferred Zustand and React Hook Form to phase 2, on
the reasoning that seat selection and a checkout form would finally justify
them. Phase 2 is here.

## Decision

Neither library is installed. Seat selection is page-local `useState` in
`seat-map-page.tsx`; the countdown is page-local state in the reservation page;
all server state stays in TanStack Query.

`spec.md`'s first principle — no technology enters without the problem it
solves — applies to the frontend too, and it outranks a promise made by an
earlier document.

## Alternatives considered

- **Import Zustand because phase 1 said so.** Honouring the letter of a plan
  whose premise turned out to be wrong. Selection is local to the seat map, the
  timer is local to the reservation page, and everything shared between screens
  is server state that TanStack Query already owns and invalidates. A store would
  have nothing to hold.
- **Import React Hook Form for the reservation flow.** There is no form. The
  flow is a set of buttons: toggle a seat, hold, confirm, cancel. Validation
  lives in the Zod contracts and is enforced by the server.
- **Lift selection into the URL.** Phase 1 puts filters in the URL because a link
  to a filtered list is meaningful. A link to "I tapped three seats but did not
  book them" is not.

## Consequences

- The dependency list is unchanged by this sub-project — no new runtime
  dependency was added at all, which is what makes sub-project 3's comparison of
  PostgreSQL against Redis honest.
- Both libraries return to consideration in sub-project 5, where a payment form
  is a real form with real cross-screen state.
- If selection ever needs to survive navigation, that is the moment to revisit
  this — not before.
