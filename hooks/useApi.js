import React from 'react';
import { describeError } from '../services/api';

/**
 * Fetches on mount and gives a screen the four states it actually has.
 *
 *   const { data, loading, error, refresh, refreshing } = useApi(Picking.queue);
 *
 * Written because every screen otherwise repeats the same twenty lines and gets
 * one of them subtly wrong — usually the unmounted-update guard, or forgetting
 * that a pull-to-refresh must not blank the list it is refreshing.
 *
 * `loading` is the first load only, when there is nothing on screen yet.
 * `refreshing` is a repeat load with data already showing. They are separate
 * because they call for different UI: a spinner in place of the content, versus
 * a spinner above content that stays put.
 *
 * `deps` re-runs the fetch, the way useEffect deps do. The fetcher itself is
 * deliberately not a dependency — screens pass inline arrows, which would
 * otherwise refetch on every render forever.
 */
export function useApi(fetcher, deps = [], { enabled = true } = {}) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(enabled);
  const [refreshing, setRefreshing] = React.useState(false);

  // Kept in a ref so `run` does not change identity when the caller passes an
  // inline function, which is what every screen does.
  const fetcherRef = React.useRef(fetcher);
  fetcherRef.current = fetcher;

  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = React.useCallback(async (isRefresh = false) => {
    if (!enabled) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const result = await fetcherRef.current();
      if (!mounted.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      // The message is the server's own where it gave one. describeError also
      // names the host when the request never landed, which on a field phone is
      // the difference between "the server said no" and "you have no signal".
      setError(describeError(err));
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [enabled]);

  React.useEffect(() => {
    run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    data,
    error,
    loading,
    refreshing,
    refresh: () => run(true),
    reload: () => run(false),
    setData,
  };
}

/**
 * The write half: runs an action, tracks whether it is in flight, and surfaces
 * the failure.
 *
 *   const approve = useAction(() => Orders.approve(id), { onDone: reload });
 *   <ActionButton loading={approve.busy} onPress={approve.run} />
 *
 * Guards against a double submit itself, because the alternative is every caller
 * remembering to — and the one that forgets books the order twice.
 */
export function useAction(action, { onDone, onFail } = {}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  const actionRef = React.useRef(action);
  actionRef.current = action;

  // Declared before `run` reads it. A ref rather than the busy state because
  // setBusy is async: two taps inside one frame both see busy === false, and the
  // second one books the order again.
  const inFlight = React.useRef(false);

  const run = React.useCallback(
    async (...args) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);

      try {
        const result = await actionRef.current(...args);
        onDone?.(result);
        return result;
      } catch (err) {
        const message = describeError(err);
        setError(message);
        onFail?.(message, err);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [onDone, onFail]
  );

  return { run, busy, error, clearError: () => setError(null) };
}
