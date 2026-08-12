import { CIRCLE_POSITION } from './geo.js';

export const ZONE_STATE = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  INSIDE: 'INSIDE',
  EXIT_CANDIDATE: 'EXIT_CANDIDATE',
  OUTSIDE: 'OUTSIDE',
  ENTRY_CANDIDATE: 'ENTRY_CANDIDATE',
});

export const ZONE_TRANSITION = Object.freeze({
  NONE: null,
  INITIALIZED_INSIDE: 'INITIALIZED_INSIDE',
  EXIT_CANDIDATE: 'EXIT_CANDIDATE',
  EXIT_CONFIRMED: 'EXIT_CONFIRMED',
  EXIT_CANCELLED: 'EXIT_CANCELLED',
  ENTRY_CANDIDATE: 'ENTRY_CANDIDATE',
  ENTRY_CONFIRMED: 'ENTRY_CONFIRMED',
  ENTRY_CANCELLED: 'ENTRY_CANCELLED',
});

function normalizedState(current) {
  const state = Object.values(ZONE_STATE).includes(current?.state)
    ? current.state
    : ZONE_STATE.UNKNOWN;

  return {
    state,
    candidateCount: Math.max(0, Number(current?.candidateCount ?? 0)),
    candidateSinceMs: Number.isFinite(current?.candidateSinceMs)
      ? current.candidateSinceMs
      : null,
  };
}

function candidateConfirmed(count, sinceMs, sampleTimeMs, confirmSamples, confirmSeconds) {
  const enoughSamples = count >= Math.max(1, confirmSamples);
  const elapsedMs = sinceMs == null ? 0 : Math.max(0, sampleTimeMs - sinceMs);
  const enoughTime = elapsedMs >= Math.max(0, confirmSeconds) * 1000;
  return enoughSamples && enoughTime;
}

/**
 * Pure allowed/safe-zone state machine. It intentionally has no clock, random
 * ID, database, or notification dependency, so recorded GPS traces can replay
 * the exact same decisions.
 */
export function advanceAllowedZoneState(current, classification, sampleTimeMs, {
  confirmSamples = 2,
  confirmSeconds = 0,
} = {}) {
  const previous = normalizedState(current);
  const unchanged = {
    ...previous,
    transition: ZONE_TRANSITION.NONE,
  };

  if (!Number.isFinite(sampleTimeMs)
      || classification === CIRCLE_POSITION.INVALID
      || classification === CIRCLE_POSITION.UNCERTAIN) {
    if (previous.state === ZONE_STATE.EXIT_CANDIDATE) {
      return {
        state: ZONE_STATE.INSIDE,
        candidateCount: 0,
        candidateSinceMs: null,
        transition: ZONE_TRANSITION.EXIT_CANCELLED,
      };
    }
    if (previous.state === ZONE_STATE.ENTRY_CANDIDATE) {
      return {
        state: ZONE_STATE.OUTSIDE,
        candidateCount: 0,
        candidateSinceMs: null,
        transition: ZONE_TRANSITION.ENTRY_CANCELLED,
      };
    }
    return unchanged;
  }

  if (previous.state === ZONE_STATE.UNKNOWN) {
    if (classification === CIRCLE_POSITION.INSIDE) {
      return {
        state: ZONE_STATE.INSIDE,
        candidateCount: 0,
        candidateSinceMs: null,
        transition: ZONE_TRANSITION.INITIALIZED_INSIDE,
      };
    }

    const count = 1;
    if (candidateConfirmed(count, sampleTimeMs, sampleTimeMs, confirmSamples, confirmSeconds)) {
      return {
        state: ZONE_STATE.OUTSIDE,
        candidateCount: 0,
        candidateSinceMs: null,
        transition: ZONE_TRANSITION.EXIT_CONFIRMED,
      };
    }
    return {
      state: ZONE_STATE.EXIT_CANDIDATE,
      candidateCount: count,
      candidateSinceMs: sampleTimeMs,
      transition: ZONE_TRANSITION.EXIT_CANDIDATE,
    };
  }

  if (previous.state === ZONE_STATE.INSIDE) {
    if (classification === CIRCLE_POSITION.INSIDE) return unchanged;

    const count = 1;
    if (candidateConfirmed(count, sampleTimeMs, sampleTimeMs, confirmSamples, confirmSeconds)) {
      return {
        state: ZONE_STATE.OUTSIDE,
        candidateCount: 0,
        candidateSinceMs: null,
        transition: ZONE_TRANSITION.EXIT_CONFIRMED,
      };
    }
    return {
      state: ZONE_STATE.EXIT_CANDIDATE,
      candidateCount: count,
      candidateSinceMs: sampleTimeMs,
      transition: ZONE_TRANSITION.EXIT_CANDIDATE,
    };
  }

  if (previous.state === ZONE_STATE.EXIT_CANDIDATE) {
    if (classification === CIRCLE_POSITION.INSIDE) {
      return {
        state: ZONE_STATE.INSIDE,
        candidateCount: 0,
        candidateSinceMs: null,
        transition: ZONE_TRANSITION.EXIT_CANCELLED,
      };
    }

    const count = previous.candidateCount + 1;
    const sinceMs = previous.candidateSinceMs ?? sampleTimeMs;
    if (candidateConfirmed(count, sinceMs, sampleTimeMs, confirmSamples, confirmSeconds)) {
      return {
        state: ZONE_STATE.OUTSIDE,
        candidateCount: 0,
        candidateSinceMs: null,
        transition: ZONE_TRANSITION.EXIT_CONFIRMED,
      };
    }
    return {
      state: ZONE_STATE.EXIT_CANDIDATE,
      candidateCount: count,
      candidateSinceMs: sinceMs,
      transition: ZONE_TRANSITION.NONE,
    };
  }

  if (previous.state === ZONE_STATE.OUTSIDE) {
    if (classification === CIRCLE_POSITION.OUTSIDE) return unchanged;

    const count = 1;
    if (candidateConfirmed(count, sampleTimeMs, sampleTimeMs, confirmSamples, confirmSeconds)) {
      return {
        state: ZONE_STATE.INSIDE,
        candidateCount: 0,
        candidateSinceMs: null,
        transition: ZONE_TRANSITION.ENTRY_CONFIRMED,
      };
    }
    return {
      state: ZONE_STATE.ENTRY_CANDIDATE,
      candidateCount: count,
      candidateSinceMs: sampleTimeMs,
      transition: ZONE_TRANSITION.ENTRY_CANDIDATE,
    };
  }

  if (classification === CIRCLE_POSITION.OUTSIDE) {
    return {
      state: ZONE_STATE.OUTSIDE,
      candidateCount: 0,
      candidateSinceMs: null,
      transition: ZONE_TRANSITION.ENTRY_CANCELLED,
    };
  }

  const count = previous.candidateCount + 1;
  const sinceMs = previous.candidateSinceMs ?? sampleTimeMs;
  if (candidateConfirmed(count, sinceMs, sampleTimeMs, confirmSamples, confirmSeconds)) {
    return {
      state: ZONE_STATE.INSIDE,
      candidateCount: 0,
      candidateSinceMs: null,
      transition: ZONE_TRANSITION.ENTRY_CONFIRMED,
    };
  }
  return {
    state: ZONE_STATE.ENTRY_CANDIDATE,
    candidateCount: count,
    candidateSinceMs: sinceMs,
    transition: ZONE_TRANSITION.NONE,
  };
}
