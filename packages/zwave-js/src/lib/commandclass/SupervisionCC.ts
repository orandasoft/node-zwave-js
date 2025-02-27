import {
	CommandClasses,
	Duration,
	isTransmissionError,
	Maybe,
	MessageOrCCLogEntry,
	MessageRecord,
	validatePayload,
	ZWaveError,
	ZWaveErrorCodes,
} from "@zwave-js/core";
import { getEnumMemberName } from "@zwave-js/shared";
import { SendDataBridgeRequest } from "../controller/SendDataBridgeMessages";
import { SendDataRequest } from "../controller/SendDataMessages";
import type { Driver } from "../driver/Driver";
import { FunctionType, MessagePriority } from "../message/Constants";
import { PhysicalCCAPI } from "./API";
import {
	API,
	CCCommand,
	CCCommandOptions,
	CommandClass,
	commandClass,
	CommandClassDeserializationOptions,
	expectedCCResponse,
	gotDeserializationOptions,
	implementedVersion,
} from "./CommandClass";

// @noSetValueAPI - This CC has no values to set
// @noInterview - This CC is only used for encapsulation

// All the supported commands
export enum SupervisionCommand {
	Get = 0x01,
	Report = 0x02,
}

/** @publicAPI */
export enum SupervisionStatus {
	NoSupport = 0x00,
	Working = 0x01,
	Fail = 0x02,
	Success = 0xff,
}

/** @publicAPI */
export interface SupervisionResult {
	status: SupervisionStatus;
	remainingDuration?: Duration;
}

let sessionId = 0;
/** Returns the next session ID to be used for supervision */
export function getNextSessionId(): number {
	// TODO: Check if this needs to be on the driver for Security 2
	sessionId = (sessionId + 1) & 0b111111;
	if (sessionId === 0) sessionId++;
	return sessionId;
}

@API(CommandClasses.Supervision)
export class SupervisionCCAPI extends PhysicalCCAPI {
	public supportsCommand(cmd: SupervisionCommand): Maybe<boolean> {
		switch (cmd) {
			case SupervisionCommand.Get:
			case SupervisionCommand.Report:
				return true; // This is mandatory
		}
		return super.supportsCommand(cmd);
	}

	public async sendEncapsulated(
		encapsulated: CommandClass,
		// If possible, keep us updated about the progress
		requestStatusUpdates: boolean = true,
	): Promise<void> {
		this.assertSupportsCommand(SupervisionCommand, SupervisionCommand.Get);

		const cc = new SupervisionCCGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			requestStatusUpdates,
			encapsulated,
		});
		await this.driver.sendCommand(cc, this.commandOptions);
	}

	public async sendReport(
		options: SupervisionCCReportOptions & { secure?: boolean },
	): Promise<void> {
		// Ask the node if it needs Wake Up On Demand,
		// unless it's overriden in `options`
		const requestWakeUpOnDemand =
			options.requestWakeUpOnDemand ??
			this.endpoint.getNodeUnsafe()?.shouldRequestWakeUpOnDemand;

		const { secure = false, ...cmdOptions } = options;
		const cc = new SupervisionCCReport(this.driver, {
			nodeId: this.endpoint.nodeId,
			...cmdOptions,
			requestWakeUpOnDemand,
		});

		// The report should be sent back with security if the received command was secure
		cc.secure = secure;

		const SendDataConstructor = this.driver.controller.isFunctionSupported(
			FunctionType.SendDataBridge,
		)
			? SendDataBridgeRequest
			: SendDataRequest;

		const msg = new SendDataConstructor(this.driver, {
			command: cc,
			// Only try sending a nonce once
			maxSendAttempts: 1,
		});

		try {
			await this.driver.sendMessage(msg, {
				...this.commandOptions,
				// Supervision Reports must be sent immediately
				priority: MessagePriority.Handshake,
				// We don't want failures causing us to treat the node as asleep or dead
				changeNodeStatusOnMissingACK: false,
			});
		} catch (e) {
			if (isTransmissionError(e)) {
				// Swallow errors related to transmission failures
				return;
			} else {
				// Pass other errors through
				throw e;
			}
		}
	}
}

@commandClass(CommandClasses.Supervision)
@implementedVersion(2)
export class SupervisionCC extends CommandClass {
	declare ccCommand: SupervisionCommand;
	// Force singlecast for the supervision CC
	declare nodeId: number;

	/** Tests if a command should be supervised and thus requires encapsulation */
	public static requiresEncapsulation(cc: CommandClass): boolean {
		return cc.supervised && !(cc instanceof SupervisionCCGet);
	}

	/** Encapsulates a command that targets a specific endpoint */
	public static encapsulate(
		driver: Driver,
		cc: CommandClass,
		requestStatusUpdates: boolean = true,
	): SupervisionCCGet {
		if (!cc.isSinglecast()) {
			throw new ZWaveError(
				`Supervision is only possible for singlecast commands!`,
				ZWaveErrorCodes.Argument_Invalid,
			);
		}

		return new SupervisionCCGet(driver, {
			nodeId: cc.nodeId,
			// Supervision CC is wrapped inside MultiChannel CCs, so the endpoint must be copied
			endpoint: cc.endpointIndex,
			encapsulated: cc,
			requestStatusUpdates,
		});
	}

	/**
	 * Given a CC instance, this returns the Supervision session ID which is used for this command.
	 * Returns `undefined` when there is no session ID or the command was sent as multicast.
	 */
	public static getSessionId(command: CommandClass): number | undefined {
		if (
			command.isEncapsulatedWith(
				CommandClasses.Supervision,
				SupervisionCommand.Get,
			)
		) {
			const supervisionEncapsulation = command.getEncapsulatingCC(
				CommandClasses.Supervision,
				SupervisionCommand.Get,
			) as SupervisionCCGet;
			if (!supervisionEncapsulation.isMulticast()) {
				return supervisionEncapsulation.sessionId;
			}
		}
	}
}

export type SupervisionCCReportOptions = {
	moreUpdatesFollow: boolean;
	requestWakeUpOnDemand?: boolean;
	sessionId: number;
} & (
	| {
			status: SupervisionStatus.Working;
			duration: Duration;
	  }
	| {
			status:
				| SupervisionStatus.NoSupport
				| SupervisionStatus.Fail
				| SupervisionStatus.Success;
	  }
);

@CCCommand(SupervisionCommand.Report)
export class SupervisionCCReport extends SupervisionCC {
	// @noCCValues

	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| (CCCommandOptions & SupervisionCCReportOptions),
	) {
		super(driver, options);

		if (gotDeserializationOptions(options)) {
			validatePayload(this.payload.length >= 3);
			this.moreUpdatesFollow = !!(this.payload[0] & 0b1_0_000000);
			this.requestWakeUpOnDemand = !!(this.payload[0] & 0b0_1_000000);
			this.sessionId = this.payload[0] & 0b111111;
			this.status = this.payload[1];
			this.duration = Duration.parseReport(this.payload[2]);
		} else {
			this.moreUpdatesFollow = options.moreUpdatesFollow;
			this.requestWakeUpOnDemand = !!options.requestWakeUpOnDemand;
			this.sessionId = options.sessionId;
			this.status = options.status;
			if (options.status === SupervisionStatus.Working) {
				this.duration = options.duration;
			} else {
				this.duration = new Duration(0, "seconds");
			}
		}
	}

	public readonly moreUpdatesFollow: boolean;
	public readonly requestWakeUpOnDemand: boolean;
	public readonly sessionId: number;
	public readonly status: SupervisionStatus;
	public readonly duration: Duration | undefined;

	public serialize(): Buffer {
		this.payload = Buffer.concat([
			Buffer.from([
				(this.moreUpdatesFollow ? 0b1_0_000000 : 0) |
					(this.requestWakeUpOnDemand ? 0b0_1_000000 : 0) |
					(this.sessionId & 0b111111),
				this.status,
			]),
		]);

		if (this.duration) {
			this.payload = Buffer.concat([
				this.payload,
				Buffer.from([this.duration.serializeReport()]),
			]);
		}
		return super.serialize();
	}

	public toLogEntry(): MessageOrCCLogEntry {
		const message: MessageRecord = {
			"session id": this.sessionId,
			"more updates follow": this.moreUpdatesFollow,
			status: getEnumMemberName(SupervisionStatus, this.status),
		};
		if (this.duration) {
			message.duration = this.duration.toString();
		}
		return {
			...super.toLogEntry(),
			message,
		};
	}
}

interface SupervisionCCGetOptions extends CCCommandOptions {
	requestStatusUpdates: boolean;
	encapsulated: CommandClass;
}

function testResponseForSupervisionCCGet(
	sent: SupervisionCCGet,
	received: SupervisionCCReport,
) {
	return received.sessionId === sent.sessionId;
}

@CCCommand(SupervisionCommand.Get)
@expectedCCResponse(SupervisionCCReport, testResponseForSupervisionCCGet)
export class SupervisionCCGet extends SupervisionCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions | SupervisionCCGetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			validatePayload(this.payload.length >= 3);
			this.requestStatusUpdates = !!(this.payload[0] & 0b1_0_000000);
			this.sessionId = this.payload[0] & 0b111111;

			this.encapsulated = CommandClass.from(this.driver, {
				data: this.payload.slice(2),
				fromEncapsulation: true,
				encapCC: this,
			});
		} else {
			this.sessionId = getNextSessionId();
			this.requestStatusUpdates = options.requestStatusUpdates;
			this.encapsulated = options.encapsulated;
			options.encapsulated.encapsulatingCC = this as any;
			// If the encapsulated command requires security, so does this one
			if (this.encapsulated.secure) this.secure = true;
		}
	}

	public requestStatusUpdates: boolean;
	public sessionId: number;
	public encapsulated: CommandClass;

	public serialize(): Buffer {
		const encapCC = this.encapsulated.serialize();
		this.payload = Buffer.concat([
			Buffer.from([
				(this.requestStatusUpdates ? 0b10_000000 : 0) |
					(this.sessionId & 0b111111),
				encapCC.length,
			]),
			encapCC,
		]);
		return super.serialize();
	}

	protected computeEncapsulationOverhead(): number {
		// Supervision CC adds two bytes (control byte + cc length)
		return super.computeEncapsulationOverhead() + 2;
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: {
				"session id": this.sessionId,
				"request updates": this.requestStatusUpdates,
			},
		};
	}
}
