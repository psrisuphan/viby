import type { PlaybackProgressPayload, PlaybackState } from "../types";

export interface PlaybackCursor {
	generation: number;
	sequence: number;
}

export interface PlaybackSnapshotOrderResult {
	progressAccepted: boolean;
	controlsAccepted: boolean;
}

export interface QueueSnapshotRequest {
	requestId: number;
	queueRevision: number;
}

/** Prevents stale backend queue pulls from replacing newer events or pulls. */
export class QueueSnapshotOrder {
	private queueRevision = 0;
	private latestRequestId = 0;

	beginRequest(): QueueSnapshotRequest {
		this.latestRequestId += 1;
		return {
			requestId: this.latestRequestId,
			queueRevision: this.queueRevision,
		};
	}

	noteQueueUpdate(): void {
		this.queueRevision += 1;
	}

	canApply(request: QueueSnapshotRequest): boolean {
		return (
			request.requestId === this.latestRequestId &&
			request.queueRevision === this.queueRevision
		);
	}
}

function cursorOf(payload: PlaybackCursor): PlaybackCursor {
	return { generation: payload.generation, sequence: payload.sequence };
}

function snapshotCursor(snapshot: PlaybackState): PlaybackCursor {
	return {
		generation: snapshot.progress_generation,
		sequence: snapshot.progress_sequence,
	};
}

export function comparePlaybackCursor(
	candidate: PlaybackCursor,
	current: PlaybackCursor,
): -1 | 0 | 1 {
	if (candidate.generation < current.generation) return -1;
	if (candidate.generation > current.generation) return 1;
	if (candidate.sequence < current.sequence) return -1;
	if (candidate.sequence > current.sequence) return 1;
	return 0;
}

function isNewer(candidate: PlaybackCursor, current: PlaybackCursor | null): boolean {
	return current === null || comparePlaybackCursor(candidate, current) > 0;
}

function isAtOrBefore(candidate: PlaybackCursor, current: PlaybackCursor): boolean {
	return comparePlaybackCursor(candidate, current) <= 0;
}

/** Keeps controls and high-rate progress ordered independently. */
export class PlaybackSyncOrder {
	private latestProgress: PlaybackCursor | null = null;
	private latestControlSeen: PlaybackCursor | null = null;
	private latestControlApplied: PlaybackCursor | null = null;
	private pendingControls: PlaybackState | null = null;

	acceptProgress(progress: PlaybackProgressPayload): boolean {
		const cursor = cursorOf(progress);
		if (!isNewer(cursor, this.latestProgress)) return false;
		this.latestProgress = cursor;
		return true;
	}

	queuePlaybackSnapshot(snapshot: PlaybackState): PlaybackSnapshotOrderResult {
		const cursor = snapshotCursor(snapshot);
		const progressAccepted = this.acceptProgress({
			position_secs: snapshot.position_secs,
			duration_secs: snapshot.duration_secs,
			generation: cursor.generation,
			sequence: cursor.sequence,
		});
		if (!isNewer(cursor, this.latestControlSeen)) {
			return { progressAccepted, controlsAccepted: false };
		}
		this.latestControlSeen = cursor;
		this.pendingControls = snapshot;
		return { progressAccepted, controlsAccepted: true };
	}

	applyInitialSnapshot(snapshot: PlaybackState): PlaybackSnapshotOrderResult {
		const cursor = snapshotCursor(snapshot);
		const progressAccepted = this.acceptProgress({
			position_secs: snapshot.position_secs,
			duration_secs: snapshot.duration_secs,
			generation: cursor.generation,
			sequence: cursor.sequence,
		});
		if (!isNewer(cursor, this.latestControlSeen)) {
			return { progressAccepted, controlsAccepted: false };
		}
		this.latestControlSeen = cursor;
		this.latestControlApplied = cursor;
		if (this.pendingControls && isAtOrBefore(snapshotCursor(this.pendingControls), cursor)) {
			this.pendingControls = null;
		}
		return { progressAccepted, controlsAccepted: true };
	}

	takePendingSnapshot(): PlaybackState | null {
		const snapshot = this.pendingControls;
		this.pendingControls = null;
		if (!snapshot) return null;
		const cursor = snapshotCursor(snapshot);
		if (!isNewer(cursor, this.latestControlApplied)) return null;
		this.latestControlApplied = cursor;
		return snapshot;
	}
}
