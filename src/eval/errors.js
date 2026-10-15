export class ProviderError extends Error {
  constructor(message, { transient = false, kind = 'provider-error' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.transient = transient;
    this.kind = kind;
  }
}
