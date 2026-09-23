import { ApiError } from "../../errors.js";

/**
 * The provider cannot honour a requested execution option: a permission mode
 * outside its supported set, or a reasoning level outside its supported
 * levels. Distinct from a machine-ceiling conflict, which the host owns, and
 * from a plain validation error, because a caller with no explicit execution
 * input may fall back to stored defaults instead of failing the request.
 */
export class ProviderCapabilityError extends ApiError {}

export function isProviderCapabilityError(
  error: unknown,
): error is ProviderCapabilityError {
  return error instanceof ProviderCapabilityError;
}
