import mongoose from "mongoose";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../errors/AppError";
import logger from "../utils/logger";

/** SPV access modes that gate decryption of a sealed asset. */
export type SpvAccessType =
  | "private"
  | "specific_users"
  | "nft_holders_only"
  | "public_with_conditions";

/** The access policy stored on an SPV record. */
export interface SpvAccessPolicy {
  accessType: SpvAccessType;
  allowedUsers?: ReadonlyArray<mongoose.Types.ObjectId | string>;
  nftContractAddress?: string | null;
}

/** The user requesting decryption, plus the asset owner they are compared against. */
export interface AccessRequester {
  userId: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  /** Linked Stellar wallet (G-address). Required for NFT-gated access. */
  stellarPublicKey?: string | null;
}

/** Returns true when `holderPublicKey` owns at least one token of the NFT contract. */
export type NftOwnershipChecker = (
  contractId: string,
  holderPublicKey: string
) => Promise<boolean>;

/**
 * Resolves whether a requester may unseal an SPV record. Every denial path
 * throws an {@link AppError}; the service never returns a partial decision.
 */
export class AccessControlService {
  constructor(
    /**
     * Injected so unit tests can supply a fake ownership check. The default
     * performs a live Soroban simulation and is loaded lazily.
     */
    private readonly checkNftOwnership: NftOwnershipChecker = queryNftBalance
  ) {}

  async assertCanUnseal(
    policy: SpvAccessPolicy,
    requester: AccessRequester
  ): Promise<void> {
    const isOwner = requester.userId.equals(requester.ownerId);

    switch (policy.accessType) {
      case "public_with_conditions":
        // Any authenticated requester. No extra conditions are defined yet.
        return;

      case "private":
        if (isOwner) return;
        throw forbidden("PRIVATE_ACCESS_ONLY", "Unauthorized: Private access only");

      case "specific_users": {
        if (isOwner || isAllowedUser(policy.allowedUsers, requester.userId)) return;
        throw forbidden(
          "NOT_ALLOWED_USER",
          "Unauthorized: You do not have permission to access this asset"
        );
      }

      case "nft_holders_only": {
        const contractId = policy.nftContractAddress;
        if (!contractId) {
          throw new AppError(
            "SPV record is NFT-gated but has no nftContractAddress",
            StatusCodes.INTERNAL_SERVER_ERROR,
            "ACCESS_POLICY_INVALID"
          );
        }
        if (!requester.stellarPublicKey) {
          throw forbidden(
            "WALLET_NOT_LINKED",
            "Unauthorized: Link a Stellar wallet to verify NFT ownership"
          );
        }

        const held = await this.checkOwnershipSafely(contractId, requester.stellarPublicKey);
        if (!held) {
          throw forbidden("NFT_NOT_HELD", "Unauthorized: Must be an NFT holder");
        }
        return;
      }

      default:
        throw new AppError(
          "Unsupported SPV access type",
          StatusCodes.INTERNAL_SERVER_ERROR,
          "ACCESS_POLICY_INVALID"
        );
    }
  }

  /**
   * Fails closed: any error from the ledger lookup becomes a 502 so the
   * request is denied and the failure is distinguishable from "not a holder".
   */
  private async checkOwnershipSafely(contractId: string, holderPublicKey: string): Promise<boolean> {
    try {
      return await this.checkNftOwnership(contractId, holderPublicKey);
    } catch (error) {
      logger.error("NFT ownership check failed", {
        contractId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(
        "Unable to verify NFT ownership right now",
        StatusCodes.BAD_GATEWAY,
        "NFT_CHECK_FAILED"
      );
    }
  }
}

function forbidden(code: string, message: string): AppError {
  return new AppError(message, StatusCodes.FORBIDDEN, code);
}

function isAllowedUser(
  allowedUsers: ReadonlyArray<mongoose.Types.ObjectId | string> | undefined,
  userId: mongoose.Types.ObjectId
): boolean {
  return (allowedUsers ?? []).some((id) => String(id) === String(userId));
}

/**
 * Calls the NFT contract's balance function (STELLAR_NFT_BALANCE_FN) through
 * a read-only Soroban simulation and reports whether the balance is positive.
 * Dependencies are required lazily so importing this module needs no credentials.
 */
async function queryNftBalance(contractId: string, holderPublicKey: string): Promise<boolean> {
  const { queryNftOwnership } = require("./contracts/NftContract") as typeof import("./contracts/NftContract");
  const result = await queryNftOwnership(contractId, holderPublicKey);
  return result.holdsToken;
}

export const accessControlService = new AccessControlService();
