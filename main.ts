import { App, Editor, Platform, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, addIcon, debounce, removeIcon } from "obsidian";

interface UnfoldToolbarSettings {
	rowsPhonePortrait: number;
	rowsPhoneLandscape: number;
	rowsTablet: number;
	startFolded: boolean;
	overflowHint: boolean;
	fitColumns: boolean;
	animate: boolean;
}

type RowsKey = "rowsPhonePortrait" | "rowsPhoneLandscape" | "rowsTablet";
type FlagKey = "startFolded" | ExperimentalKey;
/** Features still being tested: off by default, listed under "Experimental" in the settings. */
type ExperimentalKey = "overflowHint" | "fitColumns" | "animate";

const DEFAULT_SETTINGS: UnfoldToolbarSettings = {
	rowsPhonePortrait: 4,
	rowsPhoneLandscape: 2,
	rowsTablet: 4,
	startFolded: true,
	overflowHint: false,
	fitColumns: false,
	animate: false,
};

/** Row counts offered for each kind of screen, and the CSS variable suffix each one feeds. */
const ROW_LAYOUTS: Record<RowsKey, { choices: number[]; cssKey: string }> = {
	rowsPhonePortrait: { choices: [2, 3, 4, 5, 6], cssKey: "phone-portrait" },
	rowsPhoneLandscape: { choices: [1, 2, 3], cssKey: "phone-landscape" },
	rowsTablet: { choices: [2, 3, 4, 5, 6, 7, 8], cssKey: "tablet" },
};

/** Set on <body> while the toolbar is unfolded; styles.css does the rest. */
const UNFOLDED_CLASS = "ut-unfolded";
/** Obsidian sets this on <body> while its mobile toolbar is shown. */
const TOOLBAR_OPEN_CLASS = "mod-toolbar-open";
/** Per-device memory of the fold state, used only when "Start folded" is off. */
const STATE_KEY = "unfold-toolbar-unfolded";

/** Own icon id, so styles.css can flip exactly this button and nothing else. */
const ICON_ID = "unfold-toolbar-chevron";
/** Lucide's chevron-up geometry nested in a 24-unit box, so it inherits the theme's icon stroke like built-in icons. */
const ICON_SVG =
	'<svg x="0" y="0" width="100" height="100" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>';

/** Number of buttons in Obsidian's toolbar; styles.css uses it to give the unfolded toolbar a fixed width. */
const BUTTONS_PROP = "--ut-buttons";
/** Whole columns that fit on screen; styles.css narrows the unfolded toolbar to exactly that many. */
const COLUMNS_PROP = "--ut-columns";
/** Where the visible rows sit inside the scrolling list, so styles.css can fade only their edges. */
const MASK_TOP_PROP = "--ut-mask-top";
const MASK_HEIGHT_PROP = "--ut-mask-height";
/** Length of the fade at the top and bottom edge: grows with how much is hidden there, up to FADE_ROWS of a row. */
const FADE_TOP_PROP = "--ut-fade-top";
const FADE_BOTTOM_PROP = "--ut-fade-bottom";
const FADE_ROWS = 0.8;
/** Horizontal correction that keeps the narrowed toolbar's left edge, and so its buttons, in place. */
const SHIFT_PROP = "--ut-frame-shift";

/** Set on <body> while rows are out of sight above or below the visible ones; styles.css fades that edge. */
const MORE_ABOVE_CLASS = "ut-more-above";
const MORE_BELOW_CLASS = "ut-more-below";
/** Set on <body> while "Fit whole columns" has narrowed the unfolded toolbar; styles.css pins its left edge. */
const FITTED_CLASS = "ut-fitted";
/** Set for the length of the unfold and fold motion; durations match the keyframes in styles.css. */
const UNFOLDING_CLASS = "ut-unfolding";
const FOLDING_CLASS = "ut-folding";
const UNFOLD_MS = 150;
const FOLD_MS = 110;

/** Obsidian's toolbar parts: the scrolling frame and the list of buttons inside it. */
const FRAME_SELECTOR = ".mobile-toolbar-options-list-container";
const LIST_SELECTOR = ".mobile-toolbar-options-list";

/** A swipe travels at least this far vertically, mostly vertically, and quickly. */
const SWIPE_MIN_DISTANCE = 30;
const SWIPE_RATIO = 1.5;
const SWIPE_MAX_MS = 700;

const CSS_PROPS = [
	...Object.values(ROW_LAYOUTS).flatMap(({ cssKey }) => [`--ut-list-${cssKey}`, `--ut-toolbar-${cssKey}`]),
	BUTTONS_PROP,
	COLUMNS_PROP,
	MASK_TOP_PROP,
	MASK_HEIGHT_PROP,
	FADE_TOP_PROP,
	FADE_BOTTOM_PROP,
	SHIFT_PROP,
];

export default class UnfoldToolbarPlugin extends Plugin {
	settings: UnfoldToolbarSettings = { ...DEFAULT_SETTINGS };
	private scrollFrame: number | null = null;
	private motionTimer: number | null = null;
	/** The fade's next update while the rows scroll, at most one per frame. */
	private hintFrame: number | null = null;
	/** Full length of the fade in pixels; set from the theme's row height in applyHeights(). */
	private fadeLength = 44 * FADE_ROWS;
	private swipe: { x: number; y: number; time: number; moreAbove: boolean } | null = null;
	/** Runs once the screen has stopped resizing (a rotation fires several resize events). */
	private readonly relayoutAfterResize = debounce(() => this.relayout(), 300, true);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new UnfoldToolbarSettingTab(this.app, this));

		if (!Platform.isMobile) return;

		addIcon(ICON_ID, ICON_SVG);
		this.addCommand({
			id: "toggle",
			name: "Fold or unfold",
			icon: ICON_ID,
			editorCallback: (editor) => this.toggle(editor),
		});

		this.applyHeights();
		this.registerEvent(this.app.workspace.on("css-change", () => this.applyHeights()));
		this.registerDomEvent(window, "resize", () => {
			if (this.isUnfolded()) this.relayoutAfterResize();
		});
		// Listened to on the document: Obsidian rebuilds the toolbar's buttons each time it opens.
		this.registerDomEvent(document, "beforeinput", (evt) => this.onBeforeInput(evt), { capture: true, passive: true });
		this.registerDomEvent(document, "scroll", (evt) => this.onFrameScroll(evt), { capture: true, passive: true });
		this.registerDomEvent(document, "touchstart", (evt) => this.onTouchStart(evt), { capture: true, passive: true });
		this.registerDomEvent(document, "touchend", (evt) => this.onTouchEnd(evt), { capture: true, passive: false });
		this.registerDomEvent(document, "touchcancel", () => (this.swipe = null), { capture: true, passive: true });

		if (!this.settings.startFolded && this.app.loadLocalStorage(STATE_KEY) === true) {
			document.body.addClass(UNFOLDED_CLASS);
		}

		// Fold back when Obsidian closes the toolbar, if the user wants a fresh start each time.
		let wasOpen = document.body.hasClass(TOOLBAR_OPEN_CLASS);
		const observer = new MutationObserver(() => {
			const isOpen = document.body.hasClass(TOOLBAR_OPEN_CLASS);
			// Obsidian rebuilds the buttons just before it opens the toolbar.
			if (isOpen && !wasOpen) {
				this.countButtons();
				if (this.isUnfolded()) this.layoutUnfolded();
			}
			if (wasOpen && !isOpen && this.settings.startFolded) this.setUnfolded(false);
			wasOpen = isOpen;
		});
		observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
		this.register(() => observer.disconnect());
	}

	onunload(): void {
		this.relayoutAfterResize.cancel();
		if (this.scrollFrame !== null) window.cancelAnimationFrame(this.scrollFrame);
		this.scrollFrame = null;
		if (this.hintFrame !== null) window.cancelAnimationFrame(this.hintFrame);
		this.hintFrame = null;
		if (this.motionTimer !== null) window.clearTimeout(this.motionTimer);
		this.motionTimer = null;
		document.body.removeClass(UNFOLDED_CLASS, UNFOLDING_CLASS, FOLDING_CLASS, MORE_ABOVE_CLASS, MORE_BELOW_CLASS, FITTED_CLASS);
		document.body.setCssProps(Object.fromEntries(CSS_PROPS.map((prop) => [prop, ""])));
		removeIcon(ICON_ID);
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<UnfoldToolbarSettings> | null;
		const merged = { ...DEFAULT_SETTINGS, ...data };
		const rows = (key: RowsKey): number => {
			const value = Number(merged[key]);
			return ROW_LAYOUTS[key].choices.includes(value) ? value : DEFAULT_SETTINGS[key];
		};
		const flag = (key: FlagKey): boolean => {
			const value = merged[key];
			return typeof value === "boolean" ? value : DEFAULT_SETTINGS[key];
		};
		this.settings = {
			rowsPhonePortrait: rows("rowsPhonePortrait"),
			rowsPhoneLandscape: rows("rowsPhoneLandscape"),
			rowsTablet: rows("rowsTablet"),
			startFolded: flag("startFolded"),
			overflowHint: flag("overflowHint"),
			fitColumns: flag("fitColumns"),
			animate: flag("animate"),
		};
	}

	/** Settings changed on another device and arrived through sync. */
	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		if (Platform.isMobile) this.applyHeights();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		if (Platform.isMobile) this.applyHeights();
	}

	/** Called when "Start folded" changes: keep or drop this device's remembered state. */
	onStartFoldedChanged(): void {
		if (!Platform.isMobile) return;
		this.app.saveLocalStorage(STATE_KEY, this.settings.startFolded ? null : this.isUnfolded());
	}

	/** Unfolded, and not on the way to folding. */
	private isUnfolded(): boolean {
		return document.body.hasClass(UNFOLDED_CLASS) && !document.body.hasClass(FOLDING_CLASS);
	}

	private toggle(editor: Editor | undefined): void {
		this.setUnfolded(!this.isUnfolded(), true);
		if (!editor) return;
		// The note just got shorter or taller; keep the line being edited on screen.
		if (this.scrollFrame !== null) window.cancelAnimationFrame(this.scrollFrame);
		this.scrollFrame = window.requestAnimationFrame(() => {
			this.scrollFrame = null;
			const cursor = editor.getCursor("head");
			editor.scrollIntoView({ from: cursor, to: cursor });
		});
	}

	/**
	 * Rotation workaround for iOS: lays the toolbar out folded, then unfolded again, so no
	 * width measured for the previous orientation survives, and clears any sideways scroll
	 * the toolbar picked up while the screen was turning.
	 */
	private relayout(): void {
		if (!this.isUnfolded()) return;
		document.body.removeClass(UNFOLDED_CLASS);
		document.body.getBoundingClientRect();
		document.body.addClass(UNFOLDED_CLASS);
		const frame = document.body.querySelector(".mobile-toolbar-options-list-container");
		if (frame) frame.scrollLeft = 0;
		this.layoutUnfolded();
	}

	/** `animate` is true for the user's own fold and unfold, so only those get the motion. */
	private setUnfolded(unfolded: boolean, animate = false): void {
		const motion =
			animate &&
			this.settings.animate &&
			unfolded !== this.isUnfolded() &&
			!window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		this.stopMotion();
		if (!this.settings.startFolded) this.app.saveLocalStorage(STATE_KEY, unfolded);
		if (unfolded) {
			this.countButtons();
			document.body.addClass(UNFOLDED_CLASS);
			this.layoutUnfolded();
			if (motion) this.startMotion(UNFOLDING_CLASS, UNFOLD_MS);
		} else if (motion) {
			// Stays unfolded while the rows fold away, then folds for real.
			this.startMotion(FOLDING_CLASS, FOLD_MS, () => this.fold());
		} else {
			this.fold();
		}
	}

	private fold(): void {
		if (this.hintFrame !== null) window.cancelAnimationFrame(this.hintFrame);
		this.hintFrame = null;
		document.body.removeClass(UNFOLDED_CLASS, MORE_ABOVE_CLASS, MORE_BELOW_CLASS);
	}

	private startMotion(cls: string, duration: number, then?: () => void): void {
		document.body.addClass(cls);
		this.motionTimer = window.setTimeout(() => {
			this.motionTimer = null;
			document.body.removeClass(cls);
			then?.();
		}, duration);
	}

	/** Ends any motion at once; a fold that was under way is dropped, as the caller decides the state. */
	private stopMotion(): void {
		if (this.motionTimer !== null) window.clearTimeout(this.motionTimer);
		this.motionTimer = null;
		document.body.removeClass(UNFOLDING_CLASS, FOLDING_CLASS);
	}

	/**
	 * The unfolded toolbar gets the same width the folded one has (buttons × button width),
	 * set explicitly: a content-sized width can be left stale after rotating the screen.
	 */
	private countButtons(): void {
		const list = document.body.querySelector(".mobile-toolbar-options-list");
		const count = list ? list.childElementCount : 0;
		document.body.setCssProps({ [BUTTONS_PROP]: count > 0 ? String(count) : "" });
	}

	/** Lays out the unfolded rows: whole columns only, then the fade on hidden rows. */
	private layoutUnfolded(): void {
		this.snapColumns();
		this.updateOverflowHint();
	}

	/**
	 * Narrows the unfolded toolbar to the whole columns that fit, so no empty strip is left
	 * at its right end. Its left edge stays put, so no button moves: the room it frees goes to its right.
	 */
	private snapColumns(): void {
		// Measured at the width the toolbar takes without a column count: all the room there is.
		document.body.removeClass(FITTED_CLASS);
		document.body.setCssProps({ [COLUMNS_PROP]: "", [SHIFT_PROP]: "" });
		if (!this.settings.fitColumns) return;
		const frame = document.body.querySelector<HTMLElement>(FRAME_SELECTOR);
		const list = frame?.querySelector<HTMLElement>(LIST_SELECTOR);
		const button = list?.firstElementChild;
		if (!frame || !list || !(button instanceof HTMLElement)) return;
		const buttonWidth = button.getBoundingClientRect().width;
		const style = getComputedStyle(list);
		const room = list.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
		if (!(buttonWidth > 0) || !(room > 0)) return;
		const columns = Math.min(list.childElementCount, Math.max(1, Math.floor((room + 0.5) / buttonWidth)));
		// All buttons fit on one row: the toolbar already has exactly that width.
		if (columns >= list.childElementCount) return;
		const left = frame.getBoundingClientRect().left;
		document.body.addClass(FITTED_CLASS);
		document.body.setCssProps({ [COLUMNS_PROP]: String(columns) });
		// styles.css pins the left edge; if Obsidian positions the toolbar some other way, make up the difference.
		const shift = left - frame.getBoundingClientRect().left;
		if (Math.abs(shift) > 0.5) document.body.setCssProps({ [SHIFT_PROP]: `${shift}px` });
	}

	/** How far the list reaches above and below the visible rows, in pixels, from the actual layout. */
	private hiddenRows(): { frame: HTMLElement; above: number; below: number } | null {
		const frame = document.body.querySelector<HTMLElement>(FRAME_SELECTOR);
		const list = frame?.querySelector<HTMLElement>(LIST_SELECTOR);
		if (!frame || !list) return null;
		const visibleTop = frame.getBoundingClientRect().top + frame.clientTop;
		const listRect = list.getBoundingClientRect();
		return { frame, above: visibleTop - listRect.top, below: listRect.bottom - (visibleTop + frame.clientHeight) };
	}

	/**
	 * Fades the edge of the rows where more buttons are out of sight, and nothing otherwise.
	 * Each fade is as long as what is hidden on its side, up to fadeLength, so it grows and
	 * shrinks smoothly while the rows scroll instead of appearing at once.
	 */
	private updateOverflowHint(): void {
		const rows = this.settings.overflowHint && this.isUnfolded() ? this.hiddenRows() : null;
		const above = rows !== null && rows.above > 1;
		const below = rows !== null && rows.below > 1;
		document.body.toggleClass(MORE_ABOVE_CLASS, above);
		document.body.toggleClass(MORE_BELOW_CLASS, below);
		const fade = (hidden: number): string => `${Math.min(Math.max(hidden, 0), this.fadeLength)}px`;
		document.body.setCssProps(
			rows !== null && (above || below)
				? {
						[MASK_TOP_PROP]: `${rows.above}px`,
						[MASK_HEIGHT_PROP]: `${rows.frame.clientHeight}px`,
						[FADE_TOP_PROP]: fade(rows.above),
						[FADE_BOTTOM_PROP]: fade(rows.below),
					}
				: { [MASK_TOP_PROP]: "", [MASK_HEIGHT_PROP]: "", [FADE_TOP_PROP]: "", [FADE_BOTTOM_PROP]: "" }
		);
	}

	/** Keeps the fade on the rows while they scroll: one update per frame. */
	private onFrameScroll(evt: Event): void {
		if (!this.settings.overflowHint || !this.isUnfolded()) return;
		if (!(evt.target instanceof Element) || !evt.target.matches(FRAME_SELECTOR)) return;
		if (this.hintFrame !== null) return;
		this.hintFrame = window.requestAnimationFrame(() => {
			this.hintFrame = null;
			this.updateOverflowHint();
		});
	}

	/**
	 * Typing in the note folds the toolbar. Toolbar commands change the note without this event,
	 * so tapping them, even repeatedly, keeps it open.
	 * Undo and redo from the system (shake to undo) and its text formatting don't count as typing.
	 */
	private onBeforeInput(evt: InputEvent): void {
		if (!this.isUnfolded()) return;
		if (evt.inputType.startsWith("history") || evt.inputType.startsWith("format")) return;
		if (!(evt.target instanceof Element) || !evt.target.closest(".cm-content")) return;
		this.setUnfolded(false, true);
	}

	private onTouchStart(evt: TouchEvent): void {
		this.swipe = null;
		if (evt.touches.length !== 1) return;
		if (!(evt.target instanceof Element) || !evt.target.closest(FRAME_SELECTOR)) return;
		const touch = evt.touches[0];
		const rows = this.isUnfolded() ? this.hiddenRows() : null;
		this.swipe = { x: touch.clientX, y: touch.clientY, time: evt.timeStamp, moreAbove: rows !== null && rows.above > 1 };
	}

	/** Swipe up unfolds. Swipe down folds, once no rows are hidden above: until then it scrolls them into view. */
	private onTouchEnd(evt: TouchEvent): void {
		const start = this.swipe;
		this.swipe = null;
		if (!start || evt.changedTouches.length !== 1) return;
		const touch = evt.changedTouches[0];
		const dx = touch.clientX - start.x;
		const dy = touch.clientY - start.y;
		if (evt.timeStamp - start.time > SWIPE_MAX_MS) return;
		if (Math.abs(dy) < SWIPE_MIN_DISTANCE || Math.abs(dy) < SWIPE_RATIO * Math.abs(dx)) return;
		const unfolded = this.isUnfolded();
		const wanted = dy < 0 ? !unfolded : unfolded && !start.moreAbove;
		if (!wanted) return;
		// No tap on the button under the finger.
		evt.preventDefault();
		this.toggle(this.app.workspace.activeEditor?.editor);
	}

	/**
	 * Publishes the unfolded sizes in pixels for each kind of screen.
	 * The extra rows are added on top of Obsidian's own single-row height, so the
	 * bottom row stays exactly where the folded toolbar was.
	 * Plain pixel values (not calc) keep --mobile-toolbar-height readable by Obsidian's own code.
	 */
	private applyHeights(): void {
		const style = getComputedStyle(document.body);
		const rowHeight = parseFloat(style.getPropertyValue("--touch-size-m")) || 44;
		// Obsidian sizes the folded toolbar with --touch-size-l. Read that rather than
		// --mobile-toolbar-height, which this plugin overrides while unfolded.
		const toolbarHeight = parseFloat(style.getPropertyValue("--touch-size-l")) || 52;
		const props: Record<string, string> = {};
		for (const key of Object.keys(ROW_LAYOUTS) as RowsKey[]) {
			const rows = this.settings[key];
			const { cssKey } = ROW_LAYOUTS[key];
			props[`--ut-list-${cssKey}`] = `${rows * rowHeight}px`;
			props[`--ut-toolbar-${cssKey}`] = `${toolbarHeight + (rows - 1) * rowHeight}px`;
		}
		document.body.setCssProps(props);
		this.fadeLength = rowHeight * FADE_ROWS;
		// A new row count or theme changes the room the rows have.
		if (this.isUnfolded()) this.layoutUnfolded();
	}
}

/** Setting names and descriptions, shared by both settings-tab code paths. */
const TEXT = {
	startFolded: {
		name: "Start folded",
		desc: "The toolbar opens as a single row each time you start editing. Turn off to keep it the way you left it on this device.",
	},
	rowsHeading: "Rows when unfolded",
	rowsPhonePortrait: { name: "Phone, portrait", desc: "" },
	rowsPhoneLandscape: {
		name: "Phone, landscape",
		desc: "The keyboard takes most of the screen here. Choose 1 row to keep the toolbar folded.",
	},
	rowsTablet: { name: "Tablet", desc: "Used in both orientations." },
	experimentalHeading: "Experimental",
	overflowHint: {
		name: "Fade hidden rows",
		desc: "When there are more buttons than rows, the edge where more are out of sight fades out.",
	},
	fitColumns: {
		name: "Fit whole columns",
		desc: "The unfolded toolbar ends right after its last column, with no empty strip.",
	},
	animate: {
		name: "Animate",
		desc: "The toolbar unfolds and folds with a short motion. Skipped when your device is set to reduce motion.",
	},
} as const;

const EXPERIMENTAL_KEYS: ExperimentalKey[] = ["overflowHint", "fitColumns", "animate"];
const FLAG_KEYS: FlagKey[] = ["startFolded", ...EXPERIMENTAL_KEYS];
const ROW_KEYS: RowsKey[] = ["rowsPhonePortrait", "rowsPhoneLandscape", "rowsTablet"];

class UnfoldToolbarSettingTab extends PluginSettingTab {
	private readonly plugin: UnfoldToolbarPlugin;

	constructor(app: App, plugin: UnfoldToolbarPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Obsidian 1.13+: declarative settings, indexed by the global settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ ...TEXT.startFolded, control: { type: "toggle", key: "startFolded" } },
			{
				type: "group",
				heading: TEXT.rowsHeading,
				items: ROW_KEYS.map((key) => ({
					name: TEXT[key].name,
					desc: TEXT[key].desc || undefined,
					control: { type: "dropdown" as const, key, options: rowOptions(key) },
				})),
			},
			{
				type: "group",
				heading: TEXT.experimentalHeading,
				items: EXPERIMENTAL_KEYS.map((key) => ({ ...TEXT[key], control: { type: "toggle" as const, key } })),
			},
		];
	}

	/** Dropdowns store strings; the plugin keeps numbers. */
	getControlValue(key: string): unknown {
		const value = this.plugin.settings[key as keyof UnfoldToolbarSettings];
		return typeof value === "number" ? String(value) : value;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if ((FLAG_KEYS as string[]).includes(key)) {
			this.plugin.settings[key as FlagKey] = value === true;
			await this.plugin.saveSettings();
			if (key === "startFolded") this.plugin.onStartFoldedChanged();
		} else if ((ROW_KEYS as string[]).includes(key)) {
			this.plugin.settings[key as RowsKey] = Number(value);
			await this.plugin.saveSettings();
		}
	}

	/** Obsidian 1.8.7 to 1.12: the same settings, built by hand. */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.addToggle(containerEl, "startFolded");

		new Setting(containerEl).setName(TEXT.rowsHeading).setHeading();
		for (const key of ROW_KEYS) {
			const setting = new Setting(containerEl).setName(TEXT[key].name);
			if (TEXT[key].desc) setting.setDesc(TEXT[key].desc);
			setting.addDropdown((dropdown) =>
				dropdown
					.addOptions(rowOptions(key))
					.setValue(String(this.plugin.settings[key]))
					.onChange(async (value) => {
						await this.setControlValue(key, value);
					})
			);
		}

		new Setting(containerEl).setName(TEXT.experimentalHeading).setHeading();
		for (const key of EXPERIMENTAL_KEYS) this.addToggle(containerEl, key);
	}

	private addToggle(containerEl: HTMLElement, key: FlagKey): void {
		new Setting(containerEl)
			.setName(TEXT[key].name)
			.setDesc(TEXT[key].desc)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
					await this.setControlValue(key, value);
				})
			);
	}
}

function rowOptions(key: RowsKey): Record<string, string> {
	const options: Record<string, string> = {};
	for (const rows of ROW_LAYOUTS[key].choices) options[String(rows)] = rows === 1 ? "1 row" : `${rows} rows`;
	return options;
}
