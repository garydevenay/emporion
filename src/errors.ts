export class EmporionError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigValidationError extends EmporionError {}
export class IdentityError extends EmporionError {}
export class DidResolutionError extends EmporionError {}
export class TopicValidationError extends EmporionError {}
export class HandshakeError extends EmporionError {}
export class ConnectionRejectedError extends EmporionError {}
export class StorageError extends EmporionError {}
export class ProtocolValidationError extends EmporionError {}
export class ProtocolConflictError extends EmporionError {}
export class WalletAuthError extends EmporionError {}
export class WalletUnavailableError extends EmporionError {}
export class InvoiceCreationError extends EmporionError {}
export class PaymentFailedError extends EmporionError {}
