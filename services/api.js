import axios from 'axios';
import Constants from 'expo-constants';

const API_PORT = 5000;

function resolveBaseUrl() {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit.replace(/\/+$/, '');

  const hostUri = Constants.expoConfig?.hostUri || Constants.manifest?.debuggerHost;
  if (hostUri) return `http://${hostUri.split(':')[0]}:${API_PORT}`;

  return `http://localhost:${API_PORT}`;
}

export const API_BASE_URL = resolveBaseUrl();

const api = axios.create({
  baseURL: `${API_BASE_URL}/api`,
  // A field phone on rural 3G routinely takes longer than six seconds to
  // answer. The old value was short enough that ordinary slowness looked like
  // failure — which mattered enormously when failure had a fallback.
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

let authToken = null;
export function setAuthToken(token) {
  authToken = token || null;
}

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
  return () => {
    if (onUnauthorized === fn) onUnauthorized = null;
  };
}

let onShiftEnded = null;
/**
 * Called when the server says a location ping arrived outside an open shift.
 * The background task cannot reach into React to stop itself, so it says so
 * here and whoever is listening turns the task off.
 */
export function setShiftEndedHandler(fn) {
  onShiftEnded = fn;
  return () => {
    if (onShiftEnded === fn) onShiftEnded = null;
  };
}

api.interceptors.request.use((config) => {
  if (authToken) config.headers.Authorization = `Bearer ${authToken}`;
  return config;
});

/**
 * There is deliberately no offline fallback here.
 *
 * This interceptor used to answer any network error, timeout, 404 or 503 from a
 * mock backend built into this file. It was reachable in ordinary use — the
 * timeout alone was six seconds — and it did not check passwords: an unreachable
 * server meant any credentials signed you in as a seeded administrator holding
 * ["all"]. A slow check-in "succeeded" into local storage and never reached the
 * server, so the employee believed they were on shift and the sheet said absent.
 *
 * A request that cannot be answered now fails, visibly. If offline order-taking
 * is wanted, it belongs behind an explicit queue with UI that says what is
 * pending — never behind an error handler, and never in front of /auth/login.
 */
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const code = error.response?.data?.code;

    if (status === 401 && (code === 'TOKEN_EXPIRED' || code === 'TOKEN_INVALID' || code === 'ACCOUNT_INACTIVE')) {
      onUnauthorized?.(code);
    }
    if (status === 409 && (code === 'NOT_ON_SHIFT' || code === 'ON_BREAK')) {
      onShiftEnded?.(code);
    }
    return Promise.reject(error);
  }
);

export function describeError(error) {
  const serverMessage = error.response?.data?.error;
  if (serverMessage) return serverMessage;
  if (error.code === 'ECONNABORTED') return 'The server took too long to respond. Try again.';
  if (!error.response) return `Can't reach the server at ${API_BASE_URL}. Check network connection.`;
  return 'Something went wrong. Try again.';
}

export default api;
