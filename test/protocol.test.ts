import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Protocol } from "../src/index.js";
import { loadIdentityMaterial } from "../src/identity.js";
import { createTempDir, removeTempDir } from "./helpers.js";

function createSigner(identity: Awaited<ReturnType<typeof loadIdentityMaterial>>): Protocol.ProtocolSigner {
  return {
    did: identity.agentIdentity.did,
    publicKey: identity.transportKeyPair.publicKey,
    secretKey: identity.transportKeyPair.secretKey
  };
}

function now(): string {
  return new Date().toISOString();
}

test("agent did:peer profile events validate and signatures verify", async () => {
  const tempDir = await createTempDir("emporion-protocol-agent-");

  try {
    const identity = await loadIdentityMaterial(tempDir, "aa".repeat(32));
    const signer = createSigner(identity);
    const envelope = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "agent-profile",
        objectId: identity.agentIdentity.did,
        eventKind: "agent-profile.created",
        actorDid: identity.agentIdentity.did,
        subjectId: identity.agentIdentity.did,
        issuedAt: now(),
        payload: {
          displayName: "Agent A",
          bio: "Builds markets."
        }
      }),
      signer
    );

    const shape = Protocol.validateEnvelopeShape(envelope);
    assert.equal(shape.ok, true);
    assert.equal(envelope.protocol, "emporion.identity");
    assert.equal(envelope.version, "1.0");
    await Protocol.verifyProtocolEnvelopeSignature(envelope);
    const state = Protocol.applyAgentProfileEvent(undefined, envelope);
    assert.equal(state.did, identity.agentIdentity.did);
    assert.equal(state.displayName, "Agent A");
  } finally {
    await removeTempDir(tempDir);
  }
});

test("company DID is deterministic from genesis and stable on replay", async () => {
  const tempDir = await createTempDir("emporion-protocol-company-");

  try {
    const identity = await loadIdentityMaterial(tempDir, "bb".repeat(32));
    const signer = createSigner(identity);
    const issuedAt = "2026-03-07T12:00:00.000Z";
    const payload: Protocol.CompanyGenesisPayload = {
      name: "Emporion Labs",
      initialOwners: [identity.agentIdentity.did]
    };
    const companyDid = Protocol.deriveCompanyDidFromGenesis({
      actorDid: identity.agentIdentity.did,
      issuedAt,
      payload
    });
    const envelope = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "company",
        objectId: companyDid,
        eventKind: "company.genesis",
        actorDid: identity.agentIdentity.did,
        subjectId: companyDid,
        issuedAt,
        payload: payload as unknown as Record<string, Protocol.ProtocolValue>
      }),
      signer
    );

    const first = Protocol.applyCompanyEvent(undefined, envelope);
    const second = Protocol.applyCompanyEvent(undefined, envelope);
    assert.equal(first.companyDid, companyDid);
    assert.equal(second.companyDid, companyDid);
  } finally {
    await removeTempDir(tempDir);
  }
});

test("unauthorized company actions fail and role grant/revoke ordering is enforced", async () => {
  const tempDir = await createTempDir("emporion-protocol-auth-");

  try {
    const ownerIdentity = await loadIdentityMaterial(tempDir, "cc".repeat(32));
    const operatorIdentity = await loadIdentityMaterial(path.join(tempDir, "operator"), "dd".repeat(32));
    const outsiderIdentity = await loadIdentityMaterial(path.join(tempDir, "outsider"), "ee".repeat(32));
    const ownerSigner = createSigner(ownerIdentity);
    const operatorSigner = createSigner(operatorIdentity);
    const outsiderSigner = createSigner(outsiderIdentity);

    const issuedAt = "2026-03-07T12:00:00.000Z";
    const companyDid = Protocol.deriveCompanyDidFromGenesis({
      actorDid: ownerIdentity.agentIdentity.did,
      issuedAt,
      payload: {
        name: "Emporion Co",
        initialOwners: [ownerIdentity.agentIdentity.did]
      }
    });

    const genesis = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "company",
        objectId: companyDid,
        eventKind: "company.genesis",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: companyDid,
        issuedAt,
        payload: {
          name: "Emporion Co",
          initialOwners: [ownerIdentity.agentIdentity.did]
        }
      }),
      ownerSigner
    );
    const granted = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "company",
        objectId: companyDid,
        eventKind: "company.role-granted",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: companyDid,
        issuedAt: "2026-03-07T12:01:00.000Z",
        previousEventIds: [genesis.eventId],
        payload: {
          memberDid: operatorIdentity.agentIdentity.did,
          role: "operator"
        }
      }),
      ownerSigner
    );

    const companyAfterGenesis = Protocol.applyCompanyEvent(undefined, genesis);
    const companyAfterGrant = Protocol.applyCompanyEvent(companyAfterGenesis, granted);
    assert.deepEqual(companyAfterGrant.roles.operator, [operatorIdentity.agentIdentity.did]);

    const outsiderProfileUpdate = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "company",
        objectId: companyDid,
        eventKind: "company.profile-updated",
        actorDid: outsiderIdentity.agentIdentity.did,
        subjectId: companyDid,
        issuedAt: "2026-03-07T12:02:00.000Z",
        previousEventIds: [companyAfterGrant.latestEventId],
        payload: { description: "malicious update" }
      }),
      outsiderSigner
    );
    await assert.rejects(
      async () => {
        await Protocol.verifyProtocolEnvelopeSignature(outsiderProfileUpdate);
        Protocol.applyCompanyEvent(companyAfterGrant, outsiderProfileUpdate);
      },
      /owner or operator role/i
    );

    const staleGrant = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "company",
        objectId: companyDid,
        eventKind: "company.role-granted",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: companyDid,
        issuedAt: "2026-03-07T12:03:00.000Z",
        previousEventIds: [genesis.eventId],
        payload: {
          memberDid: outsiderIdentity.agentIdentity.did,
          role: "member"
        }
      }),
      ownerSigner
    );
    assert.throws(() => Protocol.applyCompanyEvent(companyAfterGrant, staleGrant), /latest event/i);

    const operatorProfileUpdate = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "company",
        objectId: companyDid,
        eventKind: "company.profile-updated",
        actorDid: operatorIdentity.agentIdentity.did,
        subjectId: companyDid,
        issuedAt: "2026-03-07T12:04:00.000Z",
        previousEventIds: [companyAfterGrant.latestEventId],
        payload: { description: "operator-approved" }
      }),
      operatorSigner
    );
    const updated = Protocol.applyCompanyEvent(companyAfterGrant, operatorProfileUpdate);
    assert.equal(updated.description, "operator-approved");
  } finally {
    await removeTempDir(tempDir);
  }
});

test("treasury and feedback credential refs reject mismatched subjects, expiry errors, and artifact hash mismatches", async () => {
  const tempDir = await createTempDir("emporion-protocol-cred-");

  try {
    const agentIdentity = await loadIdentityMaterial(tempDir, "ff".repeat(32));
    const otherIdentity = await loadIdentityMaterial(path.join(tempDir, "other"), "11".repeat(32));
    const signer = createSigner(agentIdentity);
    const artifact = {
      invoiceRef: "lnbc1...",
      provider: "custodian-a"
    };

    const attestation: Protocol.CustodialWalletAttestationRef = {
      attestationId: "att-1",
      issuerDid: otherIdentity.agentIdentity.did,
      subjectDid: agentIdentity.agentIdentity.did,
      walletAccountId: "acct-1",
      network: "bitcoin",
      currency: "SAT",
      attestedBalanceSats: 50_000,
      attestedAt: "2026-03-07T10:00:00.000Z",
      expiresAt: "2026-03-08T10:00:00.000Z",
      artifactHash: Protocol.createCredentialArtifactHash(artifact)
    };
    Protocol.validateCustodialWalletAttestationRef(attestation);
    Protocol.assertWalletAttestationArtifactMatches(attestation, artifact);

    const invalidAttestation: Protocol.CustodialWalletAttestationRef = {
      ...attestation,
      expiresAt: "2026-03-07T09:00:00.000Z"
    };
    assert.throws(() => Protocol.validateCustodialWalletAttestationRef(invalidAttestation), /after attestedAt/i);

    const feedbackRef: Protocol.FeedbackCredentialRef = {
      credentialId: "cred-1",
      issuerDid: otherIdentity.agentIdentity.did,
      subjectDid: agentIdentity.agentIdentity.did,
      relatedContractId: "contract-1",
      relatedAgreementId: "agreement-1",
      summary: {
        score: 5,
        maxScore: 5,
        headline: "Excellent",
        comment: "Delivered quickly"
      },
      issuedAt: "2026-03-07T10:00:00.000Z",
      artifactHash: Protocol.createCredentialArtifactHash({
        issuerDid: otherIdentity.agentIdentity.did,
        subjectDid: agentIdentity.agentIdentity.did,
        relatedContractId: "contract-1",
        relatedAgreementId: "agreement-1"
      })
    };
    Protocol.validateFeedbackCredentialRef(feedbackRef);
    assert.throws(
      () =>
        Protocol.assertFeedbackCredentialArtifactMatches(feedbackRef, {
          issuerDid: otherIdentity.agentIdentity.did,
          subjectDid: agentIdentity.agentIdentity.did,
          relatedContractId: "contract-1",
          relatedAgreementId: "different"
        }),
      /artifact hash mismatch/i
    );

    const created = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "agent-profile",
        objectId: agentIdentity.agentIdentity.did,
        eventKind: "agent-profile.created",
        actorDid: agentIdentity.agentIdentity.did,
        subjectId: agentIdentity.agentIdentity.did,
        issuedAt: now(),
        payload: {}
      }),
      signer
    );
    const state = Protocol.applyAgentProfileEvent(undefined, created);
    const wrongSubjectEnvelope = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "agent-profile",
        objectId: agentIdentity.agentIdentity.did,
        eventKind: "agent-profile.wallet-attestation-added",
        actorDid: agentIdentity.agentIdentity.did,
        subjectId: agentIdentity.agentIdentity.did,
        issuedAt: "2026-03-07T11:00:00.000Z",
        previousEventIds: [created.eventId],
        payload: {
          ...attestation,
          subjectDid: otherIdentity.agentIdentity.did
        } as unknown as Record<string, Protocol.ProtocolValue>
      }),
      signer
    );
    assert.throws(() => Protocol.applyAgentProfileEvent(state, wrongSubjectEnvelope), /subject must match/i);
  } finally {
    await removeTempDir(tempDir);
  }
});

test("market objects enforce valid transitions and agreement creation from accepted negotiations", async () => {
  const productCreated = {
    protocol: "emporion.protocol",
    version: 1,
    objectKind: "product",
    objectId: "product-1",
    eventKind: "product.created",
    eventId: "event-1",
    actorDid: "did:peer:agent-a",
    subjectId: "product-1",
    issuedAt: "2026-03-07T10:00:00.000Z",
    previousEventIds: [],
    payload: {
      marketplaceId: "coding",
      ownerDid: "did:emporion:company:company-a",
      title: "Agent Runtime"
    },
    attachments: [],
    signature: {
      algorithm: "ed25519",
      signerDid: "did:peer:agent-a",
      publicKeyMultibase: "z6Mkwfake",
      value: "fake"
    }
  } as unknown as Protocol.ProtocolEnvelope;

  const product = Protocol.applyProductEvent(undefined, productCreated);
  const published = Protocol.applyProductEvent(product, {
    ...productCreated,
    eventKind: "product.published",
    eventId: "event-2",
    previousEventIds: ["event-1"]
  });
  assert.equal(published.status, "published");
  assert.throws(
    () =>
      Protocol.applyProductEvent(
        { ...published, status: "retired" },
        {
          ...productCreated,
          eventKind: "product.published",
          eventId: "event-3",
          previousEventIds: ["event-2"]
        }
      ),
    /retired/i
  );

  const offerSubmitted = Protocol.applyOfferEvent(undefined, {
    ...productCreated,
    objectKind: "offer",
    objectId: "offer-1",
    subjectId: "offer-1",
    eventKind: "offer.submitted",
    eventId: "offer-event-1",
    payload: {
      marketplaceId: "coding",
      proposerDid: "did:emporion:company:company-a",
      targetObjectId: "request-1",
      paymentTerms: {
        currency: "SAT",
        amountSats: 1000,
        settlementMethod: "lightning"
      }
    }
  });
  const offerAccepted = Protocol.applyOfferEvent(offerSubmitted, {
    ...productCreated,
    objectKind: "offer",
    objectId: "offer-1",
    subjectId: "offer-1",
    eventKind: "offer.accepted",
    eventId: "offer-event-2",
    previousEventIds: ["offer-event-1"],
    payload: {}
  });
  assert.equal(offerAccepted.status, "accepted");
  assert.throws(
    () =>
      Protocol.applyOfferEvent(offerAccepted, {
        ...productCreated,
        objectKind: "offer",
        objectId: "offer-1",
        subjectId: "offer-1",
        eventKind: "offer.accepted",
        eventId: "offer-event-3",
        previousEventIds: ["offer-event-2"],
        payload: {}
      }),
    /Only open offers can be accepted/i
  );

  const agreement = Protocol.applyAgreementEvent(
    undefined,
    {
      ...productCreated,
      objectKind: "agreement",
      objectId: "agreement-1",
      subjectId: "agreement-1",
      eventKind: "agreement.created",
      eventId: "agreement-event-1",
      payload: {
        marketplaceId: "coding",
        sourceObjectKind: "offer",
        sourceObjectId: "offer-1",
        counterparties: ["did:emporion:company:company-a", "did:peer:buyer-1"],
        deliverables: ["Deliver runtime package"],
        paymentTerms: {
          currency: "SAT",
          amountSats: 1000,
          settlementMethod: "lightning"
        }
      }
    } as unknown as Protocol.ProtocolEnvelope,
    {
      offerStates: new Map([["offer-1", offerAccepted]]),
      bidStates: new Map(),
      listingStates: new Map(),
      requestStates: new Map()
    }
  );
  assert.equal(agreement.status, "active");
});

test("protocol repository rebuilds state, accepts legacy envelopes, and rejects unsupported versions", async () => {
  const protocolDir = await mkdtemp(path.join(os.tmpdir(), "emporion-protocol-repo-"));
  const signerDir = await createTempDir("emporion-protocol-repo-signer-");

  try {
    const identity = await loadIdentityMaterial(signerDir, "12".repeat(32));
    const signer = createSigner(identity);
    const repository = await Protocol.ProtocolRepository.create(protocolDir);

    const listingCreated = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "listing",
        objectId: "listing-1",
        eventKind: "listing.published",
        actorDid: identity.agentIdentity.did,
        subjectId: "listing-1",
        issuedAt: "2026-03-07T12:00:00.000Z",
        payload: {
          marketplaceId: "coding",
          sellerDid: "did:emporion:company:company-a",
          title: "Protocol design",
          paymentTerms: {
            currency: "SAT",
            amountSats: 1_000,
            settlementMethod: "lightning"
          }
        }
      }),
      signer
    );
    await repository.appendEnvelope(listingCreated);

    let marketplaceEntries = await repository.listMarketplaceEntries("coding");
    assert.equal(marketplaceEntries.length, 1);
    assert.ok(marketplaceEntries[0]);
    assert.equal(marketplaceEntries[0].objectId, "listing-1");

    const withdrawn = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "listing",
        objectId: "listing-1",
        eventKind: "listing.withdrawn",
        actorDid: identity.agentIdentity.did,
        subjectId: "listing-1",
        issuedAt: "2026-03-07T12:01:00.000Z",
        previousEventIds: [listingCreated.eventId],
        payload: {}
      }),
      signer
    );
    await repository.appendEnvelope(withdrawn);
    marketplaceEntries = await repository.listMarketplaceEntries("coding");
    assert.equal(marketplaceEntries.length, 0);

    await repository.rebuildFromLogs();
    marketplaceEntries = await repository.listMarketplaceEntries("coding");
    assert.equal(marketplaceEntries.length, 0);
    const listingState = await repository.readObjectState("listing", "listing-1");
    assert.ok(listingState && "status" in listingState);
    assert.equal(listingState.status, "withdrawn");

    const legacyListing = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        protocol: Protocol.LEGACY_EMPORION_PROTOCOL,
        version: Protocol.LEGACY_EMPORION_PROTOCOL_VERSION,
        objectKind: "listing",
        objectId: "listing-legacy-1",
        eventKind: "listing.published",
        actorDid: identity.agentIdentity.did,
        subjectId: "listing-legacy-1",
        issuedAt: "2026-03-07T12:02:00.000Z",
        payload: {
          marketplaceId: "ops",
          sellerDid: "did:emporion:company:company-a",
          title: "Legacy listing",
          paymentTerms: {
            currency: "SAT",
            amountSats: 2_000,
            settlementMethod: "lightning"
          }
        }
      }),
      signer
    );
    await repository.appendEnvelope(legacyListing);
    const legacyState = await repository.readObjectState("listing", "listing-legacy-1");
    assert.ok(legacyState && "status" in legacyState);
    assert.equal(legacyState.status, "open");

    const unsupportedVersion = {
      ...listingCreated,
      eventId: "bogus",
      version: "2.0"
    } as unknown as Protocol.ProtocolEnvelope;
    await assert.rejects(
      () => repository.appendEnvelope(unsupportedVersion),
      /Unsupported protocol version|eventId does not match|format/
    );

    await repository.close();
  } finally {
    await Promise.allSettled([removeTempDir(protocolDir), removeTempDir(signerDir)]);
  }
});
