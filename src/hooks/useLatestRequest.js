import { useCallback, useLayoutEffect, useRef } from 'react';

/** Guard asynchronous state updates after a newer request, scope change or unmount. */
const useLatestRequest = (scope) => {
  const state = useRef({ scope, sequence: 0, active: false });

  useLayoutEffect(() => {
    state.current.scope = scope;
    state.current.active = true;
    return () => {
      state.current.active = false;
      state.current.sequence += 1;
    };
  }, [scope]);

  return useCallback(() => {
    // A callback retained by a previous route/session must not invalidate or
    // overwrite the new scope's request.
    if (!state.current.active || state.current.scope !== scope) return () => false;
    const sequence = ++state.current.sequence;
    return () => state.current.active && state.current.scope === scope && state.current.sequence === sequence;
  }, [scope]);
};

export default useLatestRequest;
