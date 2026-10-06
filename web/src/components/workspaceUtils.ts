import { displayGatewayNotice } from '../services/errors';

export function errorText(error: unknown) {
  return error instanceof Error ? displayGatewayNotice(error.message) : 'The request failed. Please try again.';
}
