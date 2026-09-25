// The slice of pi's extension API used by the startup prompts (autostart and
// API-key approval): the session_start event and the dialogs its context
// offers. Structural, like the other modules' pi types.

export interface SessionStartContext {
	/** False in rpc/print modes: nobody to ask. */
	hasUI?: boolean;
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

export interface SessionStartEvent {
	/** "startup" only when pi itself starts; also "new", "resume", "fork", "reload". */
	reason: string;
}

// Optional, like status.ts: an older pi without events just never runs these.
export interface SessionStartPi {
	on?: (
		event: "session_start",
		handler: (event: SessionStartEvent, ctx: SessionStartContext) => Promise<void>,
	) => void;
}
