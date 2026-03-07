import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { AgentTransport, Protocol } from "../src/index.js";
import { loadIdentityMaterial } from "../src/identity.js";
import { runCli } from "../src/cli.js";
import { createBootstrapNode, createTempDir, removeTempDir, waitFor } from "./helpers.js";

function createSigner(identity: Awaited<ReturnType<typeof loadIdentityMaterial>>): Protocol.ProtocolSigner {
  return {
    did: identity.agentIdentity.did,
    publicKey: identity.transportKeyPair.publicKey,
    secretKey: identity.transportKeyPair.secretKey
  };
}

function createIoCapture(): {
  stdout: string[];
  stderr: string[];
  io: {
    stdout(message: string): void;
    stderr(message: string): void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout(message: string) {
        stdout.push(message);
      },
      stderr(message: string) {
        stderr.push(message);
      }
    }
  };
}

test("contract lifecycle supports evidence-backed milestone completion and contract-linked feedback", async () => {
  const repositoryDir = await createTempDir("emporion-economy-contracts-");
  const ownerDir = await createTempDir("emporion-economy-owner-");
  const workerDir = await createTempDir("emporion-economy-worker-");

  try {
    const ownerIdentity = await loadIdentityMaterial(ownerDir, "11".repeat(32));
    const workerIdentity = await loadIdentityMaterial(workerDir, "22".repeat(32));
    const ownerSigner = createSigner(ownerIdentity);
    const workerSigner = createSigner(workerIdentity);
    const repository = await Protocol.ProtocolRepository.create(repositoryDir);

    const listing = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "listing",
        objectId: "listing-contract-1",
        eventKind: "listing.published",
        actorDid: workerIdentity.agentIdentity.did,
        subjectId: "listing-contract-1",
        issuedAt: "2026-03-07T12:00:00.000Z",
        payload: {
          marketplaceId: "coding",
          sellerDid: workerIdentity.agentIdentity.did,
          title: "Implement contract protocol",
          paymentTerms: {
            currency: "SAT",
            amountSats: 2000,
            settlementMethod: "lightning"
          }
        }
      }),
      workerSigner
    );
    await repository.appendEnvelope(listing);

    const contractPayload: Protocol.ContractCreatedPayload = {
      originRef: {
        objectKind: "listing",
        objectId: "listing-contract-1"
      },
      parties: [ownerIdentity.agentIdentity.did, workerIdentity.agentIdentity.did],
      scope: "Implement the proof and resolution path",
      milestones: [
        {
          milestoneId: "ms-1",
          title: "Ship protocol reducer",
          deliverableSchema: {
            kind: "artifact",
            requiredArtifactKinds: ["patch"]
          },
          proofPolicy: {
            allowedModes: ["artifact-verifiable"],
            verifierRefs: [
              {
                verifierId: "ci",
                verifierKind: "deterministic",
                algorithm: "tsc+test"
              }
            ],
            minArtifacts: 1,
            requireCounterpartyAcceptance: false
          },
          settlementAdapters: [
            {
              adapterType: "company-reserve-lock",
              adapterId: "reserve-1",
              network: "internal",
              artifactRefs: []
            }
          ]
        }
      ],
      deliverableSchema: {
        kind: "artifact",
        requiredArtifactKinds: ["patch"]
      },
      proofPolicy: {
        allowedModes: ["artifact-verifiable"],
        verifierRefs: [
          {
            verifierId: "ci",
            verifierKind: "deterministic",
            algorithm: "tsc+test"
          }
        ],
        minArtifacts: 1,
        requireCounterpartyAcceptance: false
      },
      resolutionPolicy: {
        mode: "deterministic",
        deterministicVerifierIds: ["ci"]
      },
      settlementPolicy: {
        adapters: [
          {
            adapterType: "company-reserve-lock",
            adapterId: "reserve-1",
            network: "internal",
            artifactRefs: []
          }
        ],
        releaseCondition: "contract-completed"
      },
      deadlinePolicy: {
        milestoneDeadlines: {
          "ms-1": "2026-03-08T12:00:00.000Z"
        }
      }
    };

    const contractCreated = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "contract",
        objectId: "contract-1",
        eventKind: "contract.created",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: "contract-1",
        issuedAt: "2026-03-07T12:01:00.000Z",
        payload: Protocol.contractCreatedPayloadToJson(contractPayload)
      }),
      ownerSigner
    );
    await repository.appendEnvelope(contractCreated);

    const milestoneOpened = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "contract",
        objectId: "contract-1",
        eventKind: "contract.milestone-opened",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: "contract-1",
        issuedAt: "2026-03-07T12:02:00.000Z",
        previousEventIds: [contractCreated.eventId],
        payload: { milestoneId: "ms-1" }
      }),
      ownerSigner
    );
    await repository.appendEnvelope(milestoneOpened);

    const evidenceRecorded = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "evidence-bundle",
        objectId: "evidence-1",
        eventKind: "evidence-bundle.recorded",
        actorDid: workerIdentity.agentIdentity.did,
        subjectId: "evidence-1",
        issuedAt: "2026-03-07T12:03:00.000Z",
        payload: Protocol.evidenceBundlePayloadToJson({
          contractId: "contract-1",
          milestoneId: "ms-1",
          submitterDid: workerIdentity.agentIdentity.did,
          artifactRefs: [
            {
              artifactId: "patch",
              hash: "aa".repeat(32)
            }
          ],
          verifierRefs: [
            {
              verifierId: "ci",
              verifierKind: "deterministic",
              algorithm: "tsc+test"
            }
          ],
          proofModes: ["artifact-verifiable"],
          hashes: {
            repository: "bb".repeat(32)
          },
          executionTranscriptRefs: ["transcript-1"]
        })
      }),
      workerSigner
    );
    await repository.appendEnvelope(evidenceRecorded);

    const milestoneSubmitted = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "contract",
        objectId: "contract-1",
        eventKind: "contract.milestone-submitted",
        actorDid: workerIdentity.agentIdentity.did,
        subjectId: "contract-1",
        issuedAt: "2026-03-07T12:04:00.000Z",
        previousEventIds: [milestoneOpened.eventId],
        payload: {
          milestoneId: "ms-1",
          evidenceBundleIds: ["evidence-1"]
        }
      }),
      workerSigner
    );
    await repository.appendEnvelope(milestoneSubmitted);

    const milestoneAccepted = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "contract",
        objectId: "contract-1",
        eventKind: "contract.milestone-accepted",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: "contract-1",
        issuedAt: "2026-03-07T12:05:00.000Z",
        previousEventIds: [milestoneSubmitted.eventId],
        payload: {
          milestoneId: "ms-1",
          evidenceBundleIds: ["evidence-1"]
        }
      }),
      ownerSigner
    );
    await repository.appendEnvelope(milestoneAccepted);

    const completed = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "contract",
        objectId: "contract-1",
        eventKind: "contract.completed",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: "contract-1",
        issuedAt: "2026-03-07T12:06:00.000Z",
        previousEventIds: [milestoneAccepted.eventId],
        payload: {}
      }),
      ownerSigner
    );
    await repository.appendEnvelope(completed);

    const contractState = await repository.readObjectState("contract", "contract-1");
    assert.ok(contractState && "status" in contractState);
    assert.equal(contractState.status, "completed");

    const feedbackRef: Protocol.FeedbackCredentialRef = {
      credentialId: "feedback-contract-1",
      issuerDid: ownerIdentity.agentIdentity.did,
      subjectDid: workerIdentity.agentIdentity.did,
      relatedContractId: "contract-1",
      relatedAgreementId: "agreement-contract-1",
      completionArtifactRef: "evidence-1",
      summary: {
        score: 5,
        maxScore: 5,
        headline: "Shipped",
        comment: "Delivered with machine-verifiable evidence"
      },
      issuedAt: "2026-03-07T12:07:00.000Z",
      artifactHash: Protocol.createCredentialArtifactHash({
        relatedContractId: "contract-1",
        completionArtifactRef: "evidence-1"
      })
    };
    Protocol.validateFeedbackCredentialRef(feedbackRef);

    await repository.close();
  } finally {
    await Promise.allSettled([removeTempDir(repositoryDir), removeTempDir(ownerDir), removeTempDir(workerDir)]);
  }
});

test("disputes require authorized oracle attestations and messaging payloads decrypt only for members", async () => {
  const repositoryDir = await createTempDir("emporion-economy-disputes-");
  const ownerDir = await createTempDir("emporion-economy-owner-");
  const workerDir = await createTempDir("emporion-economy-worker-");
  const oracleDir = await createTempDir("emporion-economy-oracle-");
  const outsiderDir = await createTempDir("emporion-economy-outsider-");

  try {
    const ownerIdentity = await loadIdentityMaterial(ownerDir, "31".repeat(32));
    const workerIdentity = await loadIdentityMaterial(workerDir, "32".repeat(32));
    const oracleIdentity = await loadIdentityMaterial(oracleDir, "33".repeat(32));
    const outsiderIdentity = await loadIdentityMaterial(outsiderDir, "34".repeat(32));
    const ownerSigner = createSigner(ownerIdentity);
    const workerSigner = createSigner(workerIdentity);
    const oracleSigner = createSigner(oracleIdentity);
    const outsiderSigner = createSigner(outsiderIdentity);
    const repository = await Protocol.ProtocolRepository.create(repositoryDir);

    const listing = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "listing",
        objectId: "listing-dispute-1",
        eventKind: "listing.published",
        actorDid: workerIdentity.agentIdentity.did,
        subjectId: "listing-dispute-1",
        issuedAt: "2026-03-07T13:00:00.000Z",
        payload: {
          marketplaceId: "coding",
          sellerDid: workerIdentity.agentIdentity.did,
          title: "Resolve oracle-backed contract",
          paymentTerms: {
            currency: "SAT",
            amountSats: 3000,
            settlementMethod: "lightning"
          }
        }
      }),
      workerSigner
    );
    await repository.appendEnvelope(listing);

    const contractCreated = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "contract",
        objectId: "contract-dispute-1",
        eventKind: "contract.created",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: "contract-dispute-1",
        issuedAt: "2026-03-07T13:01:00.000Z",
        payload: Protocol.contractCreatedPayloadToJson({
          originRef: {
            objectKind: "listing",
            objectId: "listing-dispute-1"
          },
          parties: [ownerIdentity.agentIdentity.did, workerIdentity.agentIdentity.did],
          scope: "Oracle-backed dispute flow",
          milestones: [
            {
              milestoneId: "oracle-ms-1",
              title: "Deliver oracle-reviewed artifact",
              deliverableSchema: {
                kind: "oracle-claim",
                requiredArtifactKinds: ["report"]
              },
              proofPolicy: {
                allowedModes: ["oracle-attested"],
                verifierRefs: [
                  {
                    verifierId: "oracle-service",
                    verifierKind: "oracle-service",
                    verifierDid: oracleIdentity.agentIdentity.did
                  }
                ],
                requireCounterpartyAcceptance: false
              },
              settlementAdapters: [
                {
                  adapterType: "dlc-outcome",
                  adapterId: "dlc-1",
                  network: "bitcoin",
                  artifactRefs: []
                }
              ]
            }
          ],
          deliverableSchema: {
            kind: "oracle-claim",
            requiredArtifactKinds: ["report"]
          },
          proofPolicy: {
            allowedModes: ["oracle-attested"],
            verifierRefs: [
              {
                verifierId: "oracle-service",
                verifierKind: "oracle-service",
                verifierDid: oracleIdentity.agentIdentity.did
              }
            ],
            requireCounterpartyAcceptance: false
          },
          resolutionPolicy: {
            mode: "oracle",
            deterministicVerifierIds: [],
            oracleQuorum: {
              oracleDids: [oracleIdentity.agentIdentity.did],
              quorum: 1
            }
          },
          settlementPolicy: {
            adapters: [
              {
                adapterType: "dlc-outcome",
                adapterId: "dlc-1",
                network: "bitcoin",
                artifactRefs: []
              }
            ],
            releaseCondition: "oracle-ruled"
          },
          deadlinePolicy: {
            milestoneDeadlines: {
              "oracle-ms-1": "2026-03-08T13:00:00.000Z"
            }
          }
        })
      }),
      ownerSigner
    );
    await repository.appendEnvelope(contractCreated);

    const disputed = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "contract",
        objectId: "contract-dispute-1",
        eventKind: "contract.disputed",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: "contract-dispute-1",
        issuedAt: "2026-03-07T13:02:00.000Z",
        previousEventIds: [contractCreated.eventId],
        payload: {}
      }),
      ownerSigner
    );
    await repository.appendEnvelope(disputed);

    const disputeOpened = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "dispute-case",
        objectId: "dispute-1",
        eventKind: "dispute.opened",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: "dispute-1",
        issuedAt: "2026-03-07T13:03:00.000Z",
        payload: {
          contractId: "contract-dispute-1",
          milestoneId: "oracle-ms-1",
          reason: "Oracle review required"
        }
      }),
      ownerSigner
    );
    await repository.appendEnvelope(disputeOpened);

    const oracleAttestation = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "oracle-attestation",
        objectId: "oracle-attestation-1",
        eventKind: "oracle-attestation.recorded",
        actorDid: oracleIdentity.agentIdentity.did,
        subjectId: "oracle-attestation-1",
        issuedAt: "2026-03-07T13:04:00.000Z",
        payload: Protocol.oracleAttestationPayloadToJson({
          oracleDid: oracleIdentity.agentIdentity.did,
          claimType: "work.completed",
          subjectRef: {
            objectKind: "contract",
            objectId: "contract-dispute-1",
            milestoneId: "oracle-ms-1"
          },
          outcome: "completed",
          evidenceRefs: [],
          issuedAt: "2026-03-07T13:04:00.000Z",
          expiresAt: "2026-03-08T13:04:00.000Z"
        })
      }),
      oracleSigner
    );
    await repository.appendEnvelope(oracleAttestation);

    const badOracleAttestation = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "oracle-attestation",
        objectId: "oracle-attestation-unauthorized",
        eventKind: "oracle-attestation.recorded",
        actorDid: outsiderIdentity.agentIdentity.did,
        subjectId: "oracle-attestation-unauthorized",
        issuedAt: "2026-03-07T13:05:00.000Z",
        payload: Protocol.oracleAttestationPayloadToJson({
          oracleDid: outsiderIdentity.agentIdentity.did,
          claimType: "work.completed",
          subjectRef: {
            objectKind: "contract",
            objectId: "contract-dispute-1"
          },
          outcome: "completed",
          evidenceRefs: [],
          issuedAt: "2026-03-07T13:05:00.000Z",
          expiresAt: "2026-03-08T13:05:00.000Z"
        })
      }),
      outsiderSigner
    );
    await repository.appendEnvelope(badOracleAttestation);

    const ruled = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "dispute-case",
        objectId: "dispute-1",
        eventKind: "dispute.ruled",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: "dispute-1",
        issuedAt: "2026-03-07T13:06:00.000Z",
        previousEventIds: [disputeOpened.eventId],
        payload: Protocol.disputeRulingToJson({
          outcome: "fulfilled",
          resolutionMode: "oracle",
          oracleAttestationIds: ["oracle-attestation-1"],
          evidenceBundleIds: [],
          approverDids: []
        })
      }),
      ownerSigner
    );
    await repository.appendEnvelope(ruled);

    await assert.rejects(
      async () => {
        const badRuling = Protocol.signProtocolEnvelope(
          Protocol.createUnsignedEnvelope({
            objectKind: "dispute-case",
            objectId: "dispute-bad",
            eventKind: "dispute.opened",
            actorDid: ownerIdentity.agentIdentity.did,
            subjectId: "dispute-bad",
            issuedAt: "2026-03-07T13:07:00.000Z",
            payload: {
              contractId: "contract-dispute-1",
              reason: "bad oracle"
            }
          }),
          ownerSigner
        );
        await repository.appendEnvelope(badRuling);
        const unauthorizedRuling = Protocol.signProtocolEnvelope(
          Protocol.createUnsignedEnvelope({
            objectKind: "dispute-case",
            objectId: "dispute-bad",
            eventKind: "dispute.ruled",
            actorDid: ownerIdentity.agentIdentity.did,
            subjectId: "dispute-bad",
            issuedAt: "2026-03-07T13:08:00.000Z",
            previousEventIds: [badRuling.eventId],
            payload: Protocol.disputeRulingToJson({
              outcome: "fulfilled",
              resolutionMode: "oracle",
              oracleAttestationIds: ["oracle-attestation-unauthorized"],
              evidenceBundleIds: [],
              approverDids: []
            })
          }),
          ownerSigner
        );
        await repository.appendEnvelope(unauthorizedRuling);
      },
      /not authorized by the contract/i
    );

    const spaceCreated = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "space",
        objectId: "space-1",
        eventKind: "space.created",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: "space-1",
        issuedAt: "2026-03-07T13:09:00.000Z",
        payload: Protocol.spacePayloadToJson({
          spaceKind: "contract-thread",
          ownerRef: {
            kind: "contract",
            id: "contract-dispute-1"
          },
          membershipPolicy: {
            mode: "invite-only",
            ownerMemberDids: [ownerIdentity.agentIdentity.did]
          },
          encryptionPolicy: {
            mode: "member-sealed-box",
            keyAgreementMethod: "did-keyagreement-v1"
          }
        })
      }),
      ownerSigner
    );
    await repository.appendEnvelope(spaceCreated);

    const ownerMembership = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "space-membership",
        objectId: "space-1:owner",
        eventKind: "space-membership.member-added",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: "space-1:owner",
        issuedAt: "2026-03-07T13:10:00.000Z",
        payload: Protocol.spaceMembershipPayloadToJson({
          spaceId: "space-1",
          memberDid: ownerIdentity.agentIdentity.did,
          role: "owner"
        })
      }),
      ownerSigner
    );
    await repository.appendEnvelope(ownerMembership);

    const workerMembership = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "space-membership",
        objectId: "space-1:worker",
        eventKind: "space-membership.member-added",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: "space-1:worker",
        issuedAt: "2026-03-07T13:11:00.000Z",
        payload: Protocol.spaceMembershipPayloadToJson({
          spaceId: "space-1",
          memberDid: workerIdentity.agentIdentity.did,
          role: "member"
        })
      }),
      ownerSigner
    );
    await repository.appendEnvelope(workerMembership);

    const encryptedBody = await Protocol.encryptMessageForRecipients({
      plaintext: "private proof update",
      senderDid: ownerIdentity.agentIdentity.did,
      senderKeyAgreementPublicKey: ownerIdentity.agentIdentity.keyAgreementPublicKey,
      senderKeyAgreementSecretKey: ownerIdentity.keyAgreementKeyPair.secretKey,
      recipientDids: [workerIdentity.agentIdentity.did]
    });
    const messageSent = Protocol.signProtocolEnvelope(
      Protocol.createUnsignedEnvelope({
        objectKind: "message",
        objectId: "message-1",
        eventKind: "message.sent",
        actorDid: ownerIdentity.agentIdentity.did,
        subjectId: "message-1",
        issuedAt: "2026-03-07T13:12:00.000Z",
        payload: Protocol.messageSentPayloadToJson({
          spaceId: "space-1",
          messageType: "text",
          metadata: {},
          encryptedBody,
          sentAt: "2026-03-07T13:12:00.000Z"
        })
      }),
      ownerSigner
    );
    await repository.appendEnvelope(messageSent);

    const messageState = await repository.readObjectState("message", "message-1");
    assert.ok(messageState && "encryptedBody" in messageState);
    const plaintext = Protocol.decryptEncryptedMessageBody({
      encryptedBody: messageState.encryptedBody,
      recipientDid: workerIdentity.agentIdentity.did,
      recipientKeyAgreementSecretKey: workerIdentity.keyAgreementKeyPair.secretKey
    });
    assert.equal(plaintext, "private proof update");
    assert.throws(
      () =>
        Protocol.decryptEncryptedMessageBody({
          encryptedBody: messageState.encryptedBody,
          recipientDid: outsiderIdentity.agentIdentity.did,
          recipientKeyAgreementSecretKey: outsiderIdentity.keyAgreementKeyPair.secretKey
        }),
      /not addressed|Failed to decrypt/i
    );

    await repository.close();
  } finally {
    await Promise.allSettled([
      removeTempDir(repositoryDir),
      removeTempDir(ownerDir),
      removeTempDir(workerDir),
      removeTempDir(oracleDir),
      removeTempDir(outsiderDir)
    ]);
  }
});

test("protocol announcements replicate over the control feed and make spaces discoverable to peers", async () => {
  const bootstrapNode = await createBootstrapNode();
  const agentADir = await createTempDir("emporion-economy-agent-a-");
  const agentBDir = await createTempDir("emporion-economy-agent-b-");

  try {
    const initCapture = createIoCapture();
    assert.equal(
      await runCli(["agent", "init", "--data-dir", agentADir, "--display-name", "Agent A"], initCapture.io),
      0
    );
    const initPayload = JSON.parse(initCapture.stdout.join(""));
    const agentADid = initPayload.identity.did as string;

    const spaceCapture = createIoCapture();
    assert.equal(
      await runCli(
        [
          "space",
          "create",
          "--data-dir",
          agentADir,
          "--space-kind",
          "market-room",
          "--owner-kind",
          "agent",
          "--owner-id",
          agentADid,
          "--id",
          "space-discovery-1"
        ],
        spaceCapture.io
      ),
      0
    );

    const agentA = await AgentTransport.create({
      dataDir: agentADir,
      bootstrap: bootstrapNode.bootstrap,
      logLevel: "error"
    });
    const agentB = await AgentTransport.create({
      dataDir: agentBDir,
      bootstrap: bootstrapNode.bootstrap,
      logLevel: "error"
    });

    try {
      await agentA.start();
      await agentB.start();
      await agentA.joinTopic({ kind: "marketplace", marketplaceId: "economy" });
      await agentB.joinTopic({ kind: "marketplace", marketplaceId: "economy" });

      const session = await waitFor(
        () => [...agentB.getPeerSessions().values()].find((entry) => entry.remoteDid === agentA.identity.did),
        { timeoutMs: 10_000, message: "Agent B did not discover Agent A" }
      );

      assert.ok(session);
      const remoteControlFeed = await waitFor(
        async () => {
          const feed = agentB.getRemoteFeed(session.remoteControlFeedKey);
          if (!feed) {
            return undefined;
          }
          await feed.update({ wait: false });
          for (let index = 0; index < feed.length; index += 1) {
            const value = await feed.get(index);
            if (Protocol.isProtocolAnnouncement(value) && value.kind === "space-descriptor" && value.objectId === "space-discovery-1") {
              return value;
            }
          }
          return undefined;
        },
        { timeoutMs: 10_000, message: "Agent B did not receive the space descriptor announcement" }
      );
      if (!remoteControlFeed) {
        throw new Error("Expected a replicated space descriptor announcement");
      }

      assert.equal(remoteControlFeed.kind, "space-descriptor");
      assert.equal(remoteControlFeed.spaceKind, "market-room");
      assert.equal(remoteControlFeed.encryptionMode, "member-sealed-box");
    } finally {
      await Promise.allSettled([agentA.stop(), agentB.stop()]);
    }
  } finally {
    await Promise.allSettled([bootstrapNode.destroy(), removeTempDir(agentADir), removeTempDir(agentBDir)]);
  }
});
