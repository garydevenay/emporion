import { ProtocolConflictError, ProtocolValidationError } from "../errors.js";
import type { ProtocolEnvelope } from "./envelope.js";

export interface PaymentTerms {
  currency: "BTC" | "SAT";
  amountSats: number;
  settlementMethod: "lightning" | "custodial";
}

export interface LightningReference {
  type: "bolt11" | "bolt12-offer" | "bolt12-invoice-request" | "custodial-payment-ref";
  network: "bitcoin" | "testnet" | "signet" | "regtest";
  reference: string;
}

export interface ProductState {
  objectId: string;
  marketplaceId: string;
  ownerDid: string;
  status: "draft" | "published" | "unpublished" | "retired";
  title: string;
  description: string | undefined;
  latestEventId: string;
  eventIds: string[];
}

export interface ListingState {
  objectId: string;
  marketplaceId: string;
  sellerDid: string;
  status: "open" | "withdrawn" | "expired";
  title: string;
  productId: string | undefined;
  paymentTerms: PaymentTerms;
  latestEventId: string;
  eventIds: string[];
}

export interface RequestState {
  objectId: string;
  marketplaceId: string;
  requesterDid: string;
  status: "open" | "closed" | "expired";
  title: string;
  paymentTerms: PaymentTerms;
  latestEventId: string;
  eventIds: string[];
}

export interface OfferState {
  objectId: string;
  marketplaceId: string;
  proposerDid: string;
  targetObjectId: string | undefined;
  status: "open" | "accepted" | "rejected" | "canceled" | "expired";
  paymentTerms: PaymentTerms;
  lightningRefs: LightningReference[];
  latestEventId: string;
  eventIds: string[];
}

export interface BidState {
  objectId: string;
  marketplaceId: string;
  proposerDid: string;
  targetObjectId: string | undefined;
  status: "open" | "accepted" | "rejected" | "canceled" | "expired";
  paymentTerms: PaymentTerms;
  lightningRefs: LightningReference[];
  latestEventId: string;
  eventIds: string[];
}

export interface AgreementState {
  objectId: string;
  marketplaceId: string;
  sourceObjectKind: "offer" | "bid" | "listing" | "request";
  sourceObjectId: string;
  counterparties: string[];
  status: "active" | "completed" | "canceled" | "disputed";
  deliverables: string[];
  paymentTerms: PaymentTerms;
  lightningRefs: LightningReference[];
  latestEventId: string;
  eventIds: string[];
}

export type MarketStateMap = {
  product: ProductState;
  listing: ListingState;
  request: RequestState;
  offer: OfferState;
  bid: BidState;
  agreement: AgreementState;
};

function assertPaymentTerms(value: PaymentTerms): void {
  if (!Number.isInteger(value.amountSats) || value.amountSats <= 0) {
    throw new ProtocolValidationError("PaymentTerms.amountSats must be a positive integer");
  }
}

function ensurePrevious(state: { latestEventId: string } | undefined, envelope: ProtocolEnvelope, expectedCreateEvent: string): void {
  if (!state) {
    if (envelope.eventKind !== expectedCreateEvent) {
      throw new ProtocolConflictError(`First event must be ${expectedCreateEvent}`);
    }
    if (envelope.previousEventIds.length !== 0) {
      throw new ProtocolConflictError(`${expectedCreateEvent} must not reference previous events`);
    }
    return;
  }

  if (envelope.previousEventIds.length === 0 || !envelope.previousEventIds.includes(state.latestEventId)) {
    throw new ProtocolConflictError("Event must reference the latest event in previousEventIds");
  }
}

function assertOpenStatus(status: string, objectName: string): void {
  if (status !== "open" && status !== "draft" && status !== "published" && status !== "unpublished" && status !== "active") {
    throw new ProtocolConflictError(`${objectName} is not in a mutable state`);
  }
}

export function applyProductEvent(currentState: ProductState | undefined, envelope: ProtocolEnvelope): ProductState {
  ensurePrevious(currentState, envelope, "product.created");
  switch (envelope.eventKind) {
    case "product.created": {
      const payload = envelope.payload as unknown as {
        marketplaceId: string;
        ownerDid: string;
        title: string;
        description?: string;
      };
      return {
        objectId: envelope.objectId,
        marketplaceId: payload.marketplaceId,
        ownerDid: payload.ownerDid,
        status: "draft",
        title: payload.title,
        description: payload.description,
        latestEventId: envelope.eventId,
        eventIds: [envelope.eventId]
      };
    }
    case "product.updated": {
      if (!currentState) {
        throw new ProtocolConflictError("Cannot update a product before it is created");
      }
      assertOpenStatus(currentState.status, "Product");
      const payload = envelope.payload as unknown as { title?: string; description?: string };
      return {
        ...currentState,
        title: payload.title ?? currentState.title,
        description: payload.description ?? currentState.description,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "product.published":
      if (!currentState) throw new ProtocolConflictError("Cannot publish a product before it is created");
      if (currentState.status === "retired") throw new ProtocolConflictError("Cannot publish a retired product");
      return { ...currentState, status: "published", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    case "product.unpublished":
      if (!currentState) throw new ProtocolConflictError("Cannot unpublish a product before it is created");
      return { ...currentState, status: "unpublished", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    case "product.retired":
      if (!currentState) throw new ProtocolConflictError("Cannot retire a product before it is created");
      return { ...currentState, status: "retired", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    default:
      throw new ProtocolValidationError(`Unsupported product event: ${envelope.eventKind}`);
  }
}

export function applyListingEvent(currentState: ListingState | undefined, envelope: ProtocolEnvelope): ListingState {
  ensurePrevious(currentState, envelope, "listing.published");
  switch (envelope.eventKind) {
    case "listing.published": {
      const payload = envelope.payload as unknown as {
        marketplaceId: string;
        sellerDid: string;
        title: string;
        productId?: string;
        paymentTerms: PaymentTerms;
      };
      assertPaymentTerms(payload.paymentTerms);
      return {
        objectId: envelope.objectId,
        marketplaceId: payload.marketplaceId,
        sellerDid: payload.sellerDid,
        status: "open",
        title: payload.title,
        productId: payload.productId,
        paymentTerms: payload.paymentTerms,
        latestEventId: envelope.eventId,
        eventIds: [envelope.eventId]
      };
    }
    case "listing.revised": {
      if (!currentState) throw new ProtocolConflictError("Cannot revise a listing before it is published");
      if (currentState.status !== "open") throw new ProtocolConflictError("Only open listings can be revised");
      const payload = envelope.payload as unknown as { title?: string; paymentTerms?: PaymentTerms };
      if (payload.paymentTerms) assertPaymentTerms(payload.paymentTerms);
      return {
        ...currentState,
        title: payload.title ?? currentState.title,
        paymentTerms: payload.paymentTerms ?? currentState.paymentTerms,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "listing.withdrawn":
      if (!currentState) throw new ProtocolConflictError("Cannot withdraw a listing before it is published");
      return { ...currentState, status: "withdrawn", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    case "listing.expired":
      if (!currentState) throw new ProtocolConflictError("Cannot expire a listing before it is published");
      return { ...currentState, status: "expired", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    default:
      throw new ProtocolValidationError(`Unsupported listing event: ${envelope.eventKind}`);
  }
}

export function applyRequestEvent(currentState: RequestState | undefined, envelope: ProtocolEnvelope): RequestState {
  ensurePrevious(currentState, envelope, "request.published");
  switch (envelope.eventKind) {
    case "request.published": {
      const payload = envelope.payload as unknown as {
        marketplaceId: string;
        requesterDid: string;
        title: string;
        paymentTerms: PaymentTerms;
      };
      assertPaymentTerms(payload.paymentTerms);
      return {
        objectId: envelope.objectId,
        marketplaceId: payload.marketplaceId,
        requesterDid: payload.requesterDid,
        status: "open",
        title: payload.title,
        paymentTerms: payload.paymentTerms,
        latestEventId: envelope.eventId,
        eventIds: [envelope.eventId]
      };
    }
    case "request.revised": {
      if (!currentState) throw new ProtocolConflictError("Cannot revise a request before it is published");
      if (currentState.status !== "open") throw new ProtocolConflictError("Only open requests can be revised");
      const payload = envelope.payload as unknown as { title?: string; paymentTerms?: PaymentTerms };
      if (payload.paymentTerms) assertPaymentTerms(payload.paymentTerms);
      return {
        ...currentState,
        title: payload.title ?? currentState.title,
        paymentTerms: payload.paymentTerms ?? currentState.paymentTerms,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "request.closed":
      if (!currentState) throw new ProtocolConflictError("Cannot close a request before it is published");
      return { ...currentState, status: "closed", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    case "request.expired":
      if (!currentState) throw new ProtocolConflictError("Cannot expire a request before it is published");
      return { ...currentState, status: "expired", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    default:
      throw new ProtocolValidationError(`Unsupported request event: ${envelope.eventKind}`);
  }
}

function applyNegotiationEvent<TState extends OfferState | BidState>(
  currentState: TState | undefined,
  envelope: ProtocolEnvelope,
  createEventKind: string,
  objectName: "offer" | "bid"
): TState {
  ensurePrevious(currentState, envelope, createEventKind);

  switch (envelope.eventKind) {
    case createEventKind: {
      const payload = envelope.payload as unknown as {
        marketplaceId: string;
        proposerDid: string;
        targetObjectId?: string;
        paymentTerms: PaymentTerms;
        lightningRefs?: LightningReference[];
      };
      assertPaymentTerms(payload.paymentTerms);
      return {
        objectId: envelope.objectId,
        marketplaceId: payload.marketplaceId,
        proposerDid: payload.proposerDid,
        targetObjectId: payload.targetObjectId,
        status: "open",
        paymentTerms: payload.paymentTerms,
        lightningRefs: payload.lightningRefs ?? [],
        latestEventId: envelope.eventId,
        eventIds: [envelope.eventId]
      } as TState;
    }
    case `${objectName}.countered`: {
      if (!currentState) throw new ProtocolConflictError(`Cannot counter ${objectName} before it is submitted`);
      if (currentState.status !== "open") throw new ProtocolConflictError(`Only open ${objectName}s can be countered`);
      const payload = envelope.payload as unknown as {
        paymentTerms: PaymentTerms;
        lightningRefs?: LightningReference[];
      };
      assertPaymentTerms(payload.paymentTerms);
      return {
        ...currentState,
        paymentTerms: payload.paymentTerms,
        lightningRefs: payload.lightningRefs ?? currentState.lightningRefs,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case `${objectName}.rejected`:
      if (!currentState) throw new ProtocolConflictError(`Cannot reject ${objectName} before it is submitted`);
      if (currentState.status !== "open") throw new ProtocolConflictError(`Only open ${objectName}s can be rejected`);
      return { ...currentState, status: "rejected", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    case `${objectName}.canceled`:
      if (!currentState) throw new ProtocolConflictError(`Cannot cancel ${objectName} before it is submitted`);
      if (currentState.status !== "open") throw new ProtocolConflictError(`Only open ${objectName}s can be canceled`);
      return { ...currentState, status: "canceled", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    case `${objectName}.expired`:
      if (!currentState) throw new ProtocolConflictError(`Cannot expire ${objectName} before it is submitted`);
      if (currentState.status !== "open") throw new ProtocolConflictError(`Only open ${objectName}s can expire`);
      return { ...currentState, status: "expired", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    case `${objectName}.accepted`:
      if (!currentState) throw new ProtocolConflictError(`Cannot accept ${objectName} before it is submitted`);
      if (currentState.status !== "open") throw new ProtocolConflictError(`Only open ${objectName}s can be accepted`);
      return { ...currentState, status: "accepted", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    default:
      throw new ProtocolValidationError(`Unsupported ${objectName} event: ${envelope.eventKind}`);
  }
}

export function applyOfferEvent(currentState: OfferState | undefined, envelope: ProtocolEnvelope): OfferState {
  return applyNegotiationEvent(currentState, envelope, "offer.submitted", "offer");
}

export function applyBidEvent(currentState: BidState | undefined, envelope: ProtocolEnvelope): BidState {
  return applyNegotiationEvent(currentState, envelope, "bid.submitted", "bid");
}

export function applyAgreementEvent(
  currentState: AgreementState | undefined,
  envelope: ProtocolEnvelope,
  refs: {
    offerStates: Map<string, OfferState>;
    bidStates: Map<string, BidState>;
    listingStates: Map<string, ListingState>;
    requestStates: Map<string, RequestState>;
  }
): AgreementState {
  ensurePrevious(currentState, envelope, "agreement.created");
  switch (envelope.eventKind) {
    case "agreement.created": {
      const payload = envelope.payload as unknown as {
        marketplaceId: string;
        sourceObjectKind: "offer" | "bid" | "listing" | "request";
        sourceObjectId: string;
        counterparties: string[];
        deliverables: string[];
        paymentTerms: PaymentTerms;
        lightningRefs?: LightningReference[];
      };
      assertPaymentTerms(payload.paymentTerms);
      if (payload.counterparties.length < 2) {
        throw new ProtocolValidationError("Agreement must include at least two counterparties");
      }
      const sourceState =
        payload.sourceObjectKind === "offer"
          ? refs.offerStates.get(payload.sourceObjectId)
          : payload.sourceObjectKind === "bid"
            ? refs.bidStates.get(payload.sourceObjectId)
            : payload.sourceObjectKind === "listing"
              ? refs.listingStates.get(payload.sourceObjectId)
              : refs.requestStates.get(payload.sourceObjectId);
      if (!sourceState) {
        throw new ProtocolConflictError("Agreement source object does not exist");
      }
      if (sourceState.marketplaceId !== payload.marketplaceId) {
        throw new ProtocolConflictError("Agreement marketplaceId must match the accepted source object");
      }
      if ("status" in sourceState && sourceState.status !== "accepted" && payload.sourceObjectKind !== "listing" && payload.sourceObjectKind !== "request") {
        throw new ProtocolConflictError("Agreement source negotiation object must be accepted");
      }
      return {
        objectId: envelope.objectId,
        marketplaceId: payload.marketplaceId,
        sourceObjectKind: payload.sourceObjectKind,
        sourceObjectId: payload.sourceObjectId,
        counterparties: [...new Set(payload.counterparties)].sort(),
        deliverables: [...payload.deliverables],
        status: "active",
        paymentTerms: payload.paymentTerms,
        lightningRefs: payload.lightningRefs ?? [],
        latestEventId: envelope.eventId,
        eventIds: [envelope.eventId]
      };
    }
    case "agreement.completed":
      if (!currentState) throw new ProtocolConflictError("Cannot complete an agreement before it is created");
      if (currentState.status !== "active") throw new ProtocolConflictError("Only active agreements can be completed");
      return { ...currentState, status: "completed", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    case "agreement.canceled":
      if (!currentState) throw new ProtocolConflictError("Cannot cancel an agreement before it is created");
      if (currentState.status !== "active") throw new ProtocolConflictError("Only active agreements can be canceled");
      return { ...currentState, status: "canceled", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    case "agreement.disputed":
      if (!currentState) throw new ProtocolConflictError("Cannot dispute an agreement before it is created");
      if (currentState.status !== "active") throw new ProtocolConflictError("Only active agreements can be disputed");
      return { ...currentState, status: "disputed", latestEventId: envelope.eventId, eventIds: [...currentState.eventIds, envelope.eventId] };
    default:
      throw new ProtocolValidationError(`Unsupported agreement event: ${envelope.eventKind}`);
  }
}
