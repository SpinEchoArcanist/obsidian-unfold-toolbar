import {
	App,
	Editor,
	EditorPosition,
	MarkdownView,
	Menu,
	MenuPositionDef,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	View,
	addIcon,
	debounce,
	removeIcon,
	requireApiVersion,
} from "obsidian";
import { EditorView } from "@codemirror/view";

interface UnfoldToolbarSettings {
	rowsPhonePortrait: number;
	rowsPhoneLandscape: number;
	rowsTablet: number;
	startFolded: boolean;
	animate: boolean;
	statusPicker: boolean;
	statusLongPress: boolean;
	/** Statuses the user showed or hid in the picker, by checkbox character; the others follow STATUSES. */
	statusVisibility: Record<string, boolean>;
}

type RowsKey = "rowsPhonePortrait" | "rowsPhoneLandscape" | "rowsTablet";
type FlagKey = "startFolded" | "animate" | "statusPicker" | "statusLongPress";

const DEFAULT_SETTINGS: UnfoldToolbarSettings = {
	rowsPhonePortrait: 4,
	rowsPhoneLandscape: 2,
	rowsTablet: 4,
	startFolded: true,
	animate: false,
	statusPicker: false,
	statusLongPress: false,
	statusVisibility: {},
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
/** Set on <body> while the unfolded toolbar is narrowed to whole columns; styles.css pins its left edge. */
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

/** A checkbox status the picker offers: its character between the brackets, its name, and whether it is listed by default. */
interface CheckboxStatus {
	char: string;
	name: string;
	shown: boolean;
}

/**
 * The curated statuses. Shown by default: the ones most themes with alternate checkboxes draw
 * (Border and Velocity both do). Hidden by default: the larger set themes like Border add.
 */
const STATUSES: readonly CheckboxStatus[] = [
	{ char: " ", name: "To do", shown: true },
	{ char: "/", name: "In progress", shown: true },
	{ char: "x", name: "Done", shown: true },
	{ char: "-", name: "Cancelled", shown: true },
	{ char: ">", name: "Forwarded", shown: true },
	{ char: "<", name: "Scheduled", shown: true },
	{ char: "!", name: "Important", shown: true },
	{ char: "?", name: "Question", shown: true },
	{ char: "*", name: "Star", shown: false },
	{ char: '"', name: "Quote", shown: false },
	{ char: "l", name: "Location", shown: false },
	{ char: "b", name: "Bookmark", shown: false },
	{ char: "i", name: "Information", shown: false },
	{ char: "S", name: "Savings", shown: false },
	{ char: "I", name: "Idea", shown: false },
	{ char: "p", name: "Pro", shown: false },
	{ char: "c", name: "Con", shown: false },
	{ char: "u", name: "Up", shown: false },
	{ char: "d", name: "Down", shown: false },
];

const STATUS_COMMAND_ID = "set-checkbox-status";
const STATUS_ICON = "list-checks";
/** Settings control keys for the statuses: this prefix, then the checkbox character. */
const STATUS_KEY_PREFIX = "status:";
/** A tap on the toolbar this recent is the one that ran the command, so the picker opens above it. */
const TAP_MAX_AGE_MS = 2000;

/** A checkbox in Live Preview: the ones a long press opens the status list on. */
const CHECKBOX_SELECTOR = ".markdown-source-view.is-live-preview .cm-content input.task-list-item-checkbox";
/** How long a press is held, and how far it may drift, before it counts as a long press. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
/** The tap that ends a long press is dropped if it comes within this time, so the checkbox doesn't also toggle. */
const LONG_PRESS_RELEASE_MS = 2000;
/** Set on <body> while long press is on; styles.css keeps the system's own long-press selection off checkboxes. */
const LONG_PRESS_CLASS = "ut-long-press";

/**
 * A list item: any quote or callout prefix with the indentation (1), the marker (2) and the
 * space after it (3), then the checkbox character (4) when the item is a task.
 */
const LIST_ITEM_RE = /^((?:[ \t]*>)*[ \t]*)([-*+]|\d+[.)])([ \t]+)(?:\[(.)\](?=[ \t]|$))?/u;
/** The quote or callout prefix and indentation of any line. */
const LINE_PREFIX_RE = /^(?:[ \t]*>)*[ \t]*/;

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
	/** Whether the "Set checkbox status" command is registered: only while its setting is on. */
	private statusCommandAdded = false;
	/** Where and when the toolbar was last tapped, so the status picker opens above that button. */
	private lastToolbarTap: { x: number; time: number } | null = null;
	/** A press on a checkbox that may become a long press. */
	private press: { checkbox: HTMLElement; x: number; y: number; timer: number } | null = null;
	/** The checkbox a long press just opened the list for, whose release is dropped. */
	private pressed: { checkbox: HTMLElement; time: number } | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new UnfoldToolbarSettingTab(this.app, this));
		// The status picker works on desktop too, so it is set up before the mobile-only part.
		this.syncStatusCommand();
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				if (!this.settings.statusPicker) return;
				menu.addItem((item) =>
					item
						.setTitle(TEXT.statusCommand)
						.setIcon(STATUS_ICON)
						// Opened once the editor menu has closed, so its closing doesn't take the list along.
						.onClick(() => window.setTimeout(() => this.openStatusMenu(editor), 0))
				);
			})
		);
		this.syncLongPress();
		// On window, ahead of the editor's own listeners, so a long press can keep the checkbox from toggling.
		this.registerDomEvent(window, "pointerdown", (evt) => this.onPressStart(evt), { capture: true, passive: true });
		this.registerDomEvent(window, "pointermove", (evt) => this.onPressMove(evt), { capture: true, passive: true });
		this.registerDomEvent(window, "pointerup", () => this.cancelPress(), { capture: true, passive: true });
		this.registerDomEvent(window, "pointercancel", () => this.cancelPress(), { capture: true, passive: true });
		this.registerDomEvent(window, "touchend", (evt) => this.dropRelease(evt), { capture: true, passive: false });
		this.registerDomEvent(window, "click", (evt) => this.dropRelease(evt), { capture: true });
		this.registerDomEvent(window, "contextmenu", (evt) => this.dropRelease(evt), { capture: true });

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
		this.registerDomEvent(document, "pointerdown", (evt) => this.rememberToolbarTap(evt), { capture: true, passive: true });

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
		this.cancelPress();
		document.body.removeClass(LONG_PRESS_CLASS);
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
		// Only known statuses with a true/false value are kept.
		const statusVisibility: Record<string, boolean> = {};
		const storedVisibility: unknown = merged.statusVisibility;
		if (storedVisibility !== null && typeof storedVisibility === "object") {
			for (const { char } of STATUSES) {
				const value = (storedVisibility as Record<string, unknown>)[char];
				if (typeof value === "boolean") statusVisibility[char] = value;
			}
		}
		this.settings = {
			rowsPhonePortrait: rows("rowsPhonePortrait"),
			rowsPhoneLandscape: rows("rowsPhoneLandscape"),
			rowsTablet: rows("rowsTablet"),
			startFolded: flag("startFolded"),
			animate: flag("animate"),
			statusPicker: flag("statusPicker"),
			statusLongPress: flag("statusLongPress"),
			statusVisibility,
		};
	}

	/** Settings changed on another device and arrived through sync. */
	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		this.syncStatusCommand();
		this.syncLongPress();
		if (Platform.isMobile) this.applyHeights();
	}

	/** Registers or removes the "Set checkbox status" command to match its setting. */
	syncStatusCommand(): void {
		const wanted = this.settings.statusPicker;
		if (wanted === this.statusCommandAdded) return;
		if (wanted) {
			this.addCommand({
				id: STATUS_COMMAND_ID,
				name: TEXT.statusCommand,
				icon: STATUS_ICON,
				editorCallback: (editor) => this.openStatusMenu(editor),
			});
		} else {
			this.removeCommand(STATUS_COMMAND_ID);
		}
		this.statusCommandAdded = wanted;
	}

	/** The status list is in use, through the command or the long press, so its statuses can be chosen. */
	usesStatusList(): boolean {
		return this.settings.statusPicker || this.settings.statusLongPress;
	}

	isStatusShown(status: CheckboxStatus): boolean {
		return this.settings.statusVisibility[status.char] ?? status.shown;
	}

	/**
	 * Lists the shown statuses, each drawn by the theme, with the lines' current status ticked.
	 * The list applies to every line the cursors or selections touch, or, after a long press,
	 * to the pressed checkbox's line only.
	 */
	private openStatusMenu(editor: Editor, pressed?: { line: number; position: MenuPositionDef }): void {
		const lines = pressed ? [pressed.line] : targetLines(editor);
		const texts = lines.map((line) => editor.getLine(line));
		const current = commonStatus(texts);
		const menu = new Menu().setNoIcon().setUseNativeMenu(false);
		for (const status of STATUSES) {
			if (!this.isStatusShown(status)) continue;
			menu.addItem((item) => {
				item.setTitle(statusTitle(status)).onClick(() => this.applyStatus(editor, lines, status.char, !pressed));
				if (status.char === current) item.setChecked(true);
			});
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(TEXT.removeCheckbox)
				.setDisabled(!texts.some((text) => taskChar(text) !== null))
				.onClick(() => this.applyStatus(editor, lines, null, !pressed))
		);
		menu.showAtPosition(pressed ? pressed.position : this.statusMenuPosition());
	}

	/** On mobile, just above the toolbar button that was tapped; otherwise at the cursor. */
	private statusMenuPosition(): MenuPositionDef {
		const frame = document.body.hasClass(TOOLBAR_OPEN_CLASS) ? document.body.querySelector<HTMLElement>(FRAME_SELECTOR) : null;
		if (frame) {
			const rect = frame.getBoundingClientRect();
			const tap = this.lastToolbarTap;
			const recent = tap !== null && Date.now() - tap.time < TAP_MAX_AGE_MS;
			return { x: recent ? tap.x : rect.left, y: rect.top };
		}
		const selection = activeWindow.getSelection();
		if (selection && selection.rangeCount > 0) {
			const rect = selection.getRangeAt(0).getBoundingClientRect();
			if (rect.bottom > 0 || rect.left > 0) return { x: rect.left, y: rect.bottom };
		}
		return { x: activeWindow.innerWidth / 2, y: activeWindow.innerHeight / 3 };
	}

	/**
	 * Gives the lines the checkbox `char`, or removes their checkbox when `char` is null, in one undo step.
	 * Picking the status all the lines already have turns them back to "[ ]".
	 * `atCursor` is true when the lines came from the cursors: they are kept in place and the note
	 * gets the focus back. After a long press it is false, so the cursor, the scroll position and
	 * the keyboard (hidden or shown) are left as they were.
	 */
	private applyStatus(editor: Editor, lines: number[], char: string | null, atCursor: boolean): void {
		const texts = lines.map((line) => editor.getLine(line));
		const target = char !== null && char !== " " && commonStatus(texts) === char ? " " : char;
		const edits: LineEditAt[] = [];
		lines.forEach((line, i) => {
			const edit = checkboxEdit(texts[i], target);
			if (edit) edits.push({ line, ...edit });
		});
		if (edits.length > 0) {
			const selections = editor
				.listSelections()
				.map(({ anchor, head }) => ({ anchor: mapPosition(anchor, edits), head: mapPosition(head, edits) }));
			editor.transaction({
				changes: edits.map(({ line, from, to, insert }) => ({ from: { line, ch: from }, to: { line, ch: to }, text: insert })),
			});
			if (atCursor) editor.setSelections(selections);
		}
		if (atCursor) editor.focus();
	}

	/** Long press is listened for only while its setting is on; styles.css follows the body class. */
	syncLongPress(): void {
		if (!this.settings.statusLongPress) this.cancelPress();
		document.body.toggleClass(LONG_PRESS_CLASS, this.settings.statusLongPress);
	}

	private onPressStart(evt: PointerEvent): void {
		this.cancelPress();
		if (!this.settings.statusLongPress || !evt.isPrimary) return;
		if (evt.pointerType === "mouse" && evt.button !== 0) return;
		const checkbox = evt.target instanceof Element ? evt.target.closest<HTMLElement>(CHECKBOX_SELECTOR) : null;
		if (!checkbox) return;
		const timer = window.setTimeout(() => this.onLongPress(), LONG_PRESS_MS);
		this.press = { checkbox, x: evt.clientX, y: evt.clientY, timer };
	}

	/** A press that drifts is a scroll or a drag, not a long press. */
	private onPressMove(evt: PointerEvent): void {
		const press = this.press;
		if (!press || !evt.isPrimary) return;
		if (Math.hypot(evt.clientX - press.x, evt.clientY - press.y) > LONG_PRESS_SLOP) this.cancelPress();
	}

	private cancelPress(): void {
		if (this.press) window.clearTimeout(this.press.timer);
		this.press = null;
	}

	/** Opens the status list under the held checkbox, for its line only. */
	private onLongPress(): void {
		const press = this.press;
		this.press = null;
		if (!press || !press.checkbox.isConnected) return;
		const located = locateCheckbox(this.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view), press.checkbox);
		if (!located) return;
		this.pressed = { checkbox: press.checkbox, time: Date.now() };
		const rect = press.checkbox.getBoundingClientRect();
		this.openStatusMenu(located.editor, { line: located.line, position: { x: rect.left, y: rect.bottom } });
	}

	/**
	 * The release of a long press would toggle the checkbox, and on some systems open their own menu:
	 * both are dropped. Only for the pressed checkbox, so taps on the status list go through.
	 */
	private dropRelease(evt: Event): void {
		const pressed = this.pressed;
		if (!pressed) return;
		if (Date.now() - pressed.time > LONG_PRESS_RELEASE_MS) {
			this.pressed = null;
			return;
		}
		if (!(evt.target instanceof Node) || !pressed.checkbox.contains(evt.target)) return;
		evt.preventDefault();
		evt.stopImmediatePropagation();
		// The release ends with the click, or with the touch end when that stops the click from coming.
		if (evt.type === "click" || evt.type === "touchend") this.pressed = null;
	}

	private rememberToolbarTap(evt: PointerEvent): void {
		if (!(evt.target instanceof Element) || !evt.target.closest(FRAME_SELECTOR)) return;
		this.lastToolbarTap = { x: evt.clientX, time: Date.now() };
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
		document.body.removeClass(UNFOLDED_CLASS, MORE_ABOVE_CLASS, MORE_BELOW_CLASS, FITTED_CLASS);
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
		const rows = this.isUnfolded() ? this.hiddenRows() : null;
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
		if (!this.isUnfolded()) return;
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
	animate: {
		name: "Animate",
		desc: "The toolbar unfolds and folds with a short motion. Skipped when your device is set to reduce motion.",
	},
	rowsHeading: "Rows when unfolded",
	rowsPhonePortrait: { name: "Phone, portrait", desc: "" },
	rowsPhoneLandscape: {
		name: "Phone, landscape",
		desc: "The keyboard takes most of the screen here. Choose 1 row to keep the toolbar folded.",
	},
	rowsTablet: { name: "Tablet", desc: "Used in both orientations." },
	experimentalHeading: "Experimental",
	experimentalNote: {
		name: "Features in testing",
		desc: "New features appear here first, switched off, while they are being tested. Once tested, they become standard or are removed.",
		empty: " Nothing is being tested at the moment.",
	},
	statusPicker: {
		name: "Checkbox status picker",
		desc: 'Adds the command "Set checkbox status", also to the editor\'s context menu. It lists checkbox statuses as your theme draws them and applies the one you pick to the current line or the selected lines. Also works on desktop.',
	},
	statusLongPress: {
		name: "Long press on a checkbox",
		desc: "In Live Preview, holding a checkbox opens the list of checkbox statuses for its line. A short tap still ticks it as usual.",
	},
	statuses: {
		name: "Checkbox statuses",
		desc: "Choose which statuses the list shows. How each one looks depends on your theme.",
	},
	statusCommand: "Set checkbox status",
	removeCheckbox: "Remove checkbox",
} as const;

/** Features still being tested: off by default, listed under "Experimental" in the settings. */
const EXPERIMENTAL_KEYS: FlagKey[] = ["statusPicker", "statusLongPress"];
const FLAG_KEYS: FlagKey[] = ["startFolded", "animate", ...EXPERIMENTAL_KEYS];
/** The Experimental section's explanation, which also says when nothing is being tested. */
const EXPERIMENTAL_NOTE = {
	name: TEXT.experimentalNote.name,
	desc: TEXT.experimentalNote.desc + (EXPERIMENTAL_KEYS.length === 0 ? TEXT.experimentalNote.empty : ""),
};
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
			{ ...TEXT.animate, control: { type: "toggle", key: "animate" } },
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
				items: [
					{ ...EXPERIMENTAL_NOTE, searchable: false },
					...EXPERIMENTAL_KEYS.map((key) => ({ ...TEXT[key], control: { type: "toggle" as const, key } })),
					{
						type: "page",
						...TEXT.statuses,
						visible: () => this.plugin.usesStatusList(),
						items: [
							{
								type: "group",
								items: STATUSES.map((status) => ({
									name: status.name,
									desc: `[${status.char}]`,
									control: { type: "toggle" as const, key: STATUS_KEY_PREFIX + status.char },
								})),
							},
						],
					},
				],
			},
		];
	}

	/** Dropdowns store strings; the plugin keeps numbers. */
	getControlValue(key: string): unknown {
		const status = statusForKey(key);
		if (status) return this.plugin.isStatusShown(status);
		const value = this.plugin.settings[key as keyof UnfoldToolbarSettings];
		return typeof value === "number" ? String(value) : value;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const status = statusForKey(key);
		if (status) {
			this.plugin.settings.statusVisibility[status.char] = value === true;
			await this.plugin.saveSettings();
		} else if ((FLAG_KEYS as string[]).includes(key)) {
			this.plugin.settings[key as FlagKey] = value === true;
			await this.plugin.saveSettings();
			if (key === "startFolded") this.plugin.onStartFoldedChanged();
			if (key === "statusPicker" || key === "statusLongPress") {
				this.plugin.syncStatusCommand();
				this.plugin.syncLongPress();
				// The list of statuses shows only while the picker is on.
				if (requireApiVersion("1.13.0")) this.refreshDomState();
				else this.renderByHand();
			}
		} else if ((ROW_KEYS as string[]).includes(key)) {
			this.plugin.settings[key as RowsKey] = Number(value);
			await this.plugin.saveSettings();
		}
	}

	/** Obsidian 1.8.7 to 1.12: the same settings, built by hand. */
	display(): void {
		this.renderByHand();
	}

	private renderByHand(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.addToggle(containerEl, "startFolded");
		this.addToggle(containerEl, "animate");

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
		new Setting(containerEl).setName(EXPERIMENTAL_NOTE.name).setDesc(EXPERIMENTAL_NOTE.desc);
		for (const key of EXPERIMENTAL_KEYS) this.addToggle(containerEl, key);

		if (!this.plugin.usesStatusList()) return;
		new Setting(containerEl).setName(TEXT.statuses.name).setDesc(TEXT.statuses.desc).setHeading();
		for (const status of STATUSES) {
			new Setting(containerEl)
				.setName(status.name)
				.setDesc(`[${status.char}]`)
				.addToggle((toggle) =>
					toggle.setValue(this.plugin.isStatusShown(status)).onChange(async (value) => {
						await this.setControlValue(STATUS_KEY_PREFIX + status.char, value);
					})
				);
		}
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

function statusForKey(key: string): CheckboxStatus | undefined {
	if (!key.startsWith(STATUS_KEY_PREFIX)) return undefined;
	const char = key.slice(STATUS_KEY_PREFIX.length);
	return STATUSES.find((status) => status.char === char);
}

/** One change within a line: characters from..to replaced by insert. */
interface LineEdit {
	from: number;
	to: number;
	insert: string;
}
type LineEditAt = LineEdit & { line: number };

/** The checkbox character of a task line, or null when the line is not a task. */
function taskChar(text: string): string | null {
	return LIST_ITEM_RE.exec(text)?.[4] ?? null;
}

/** The status every line shares, or null when they differ or one of them is not a task. */
function commonStatus(texts: string[]): string | null {
	const first = texts.length > 0 ? taskChar(texts[0]) : null;
	return first !== null && texts.every((text) => taskChar(text) === first) ? first : null;
}

/**
 * The change that gives a line the checkbox `char`, or removes its checkbox when `char` is null;
 * null when nothing changes. A task gets its character replaced, a list item gets a checkbox,
 * and any other line becomes a task. Indentation and quote or callout prefixes are kept.
 */
function checkboxEdit(text: string, char: string | null): LineEdit | null {
	const match = LIST_ITEM_RE.exec(text);
	if (match) {
		const at = match[1].length + match[2].length + match[3].length;
		const current = match[4];
		if (current !== undefined) {
			const end = at + current.length + 2;
			// Removing takes the space after the checkbox along, so "- [x] a" becomes "- a".
			if (char === null) return { from: at, to: Math.min(text.length, end + 1), insert: "" };
			return current === char ? null : { from: at + 1, to: at + 1 + current.length, insert: char };
		}
		return char === null ? null : { from: at, to: at, insert: `[${char}] ` };
	}
	if (char === null) return null;
	const at = LINE_PREFIX_RE.exec(text)?.[0].length ?? 0;
	return { from: at, to: at, insert: `- [${char}] ` };
}

/** Where a cursor ends up once its line is edited: text inserted at or before it pushes it along. */
function mapPosition(pos: EditorPosition, edits: LineEditAt[]): EditorPosition {
	const edit = edits.find(({ line }) => line === pos.line);
	if (!edit || pos.ch < edit.from) return pos;
	if (pos.ch >= edit.to) return { line: pos.line, ch: pos.ch + edit.insert.length - (edit.to - edit.from) };
	return { line: pos.line, ch: edit.from + edit.insert.length };
}

/**
 * The editor and line of a checkbox in Live Preview. CodeMirror finds the position of its own
 * DOM; the note's view, whose editor changes the text, is the one that contains the checkbox.
 */
function locateCheckbox(views: View[], checkbox: HTMLElement): { editor: Editor; line: number } | null {
	const editorEl = checkbox.closest<HTMLElement>(".cm-editor");
	const cm = editorEl ? EditorView.findFromDOM(editorEl) : null;
	const view = views.find((candidate): candidate is MarkdownView => candidate instanceof MarkdownView && candidate.containerEl.contains(checkbox));
	if (!cm || !view) return null;
	return { editor: view.editor, line: cm.state.doc.lineAt(cm.posAtDOM(checkbox)).number - 1 };
}

/** Every line a cursor or selection touches, once each; a selection ending at the start of a line leaves that line out. */
function targetLines(editor: Editor): number[] {
	const lines = new Set<number>();
	for (const { anchor, head } of editor.listSelections()) {
		const [start, end] = anchor.line < head.line || (anchor.line === head.line && anchor.ch <= head.ch) ? [anchor, head] : [head, anchor];
		const last = end.line > start.line && end.ch === 0 ? end.line - 1 : end.line;
		for (let line = start.line; line <= last; line++) lines.add(line);
	}
	return [...lines].sort((a, b) => a - b);
}

/**
 * A picker row: the status as a one-line task, built like the reading view builds one
 * (data-task on the item and its checkbox), so the theme draws both the box and the text,
 * then the character itself, which reads the same in every theme.
 */
function statusTitle(status: CheckboxStatus): DocumentFragment {
	const checked = status.char !== " ";
	return createFragment((fragment) => {
		const row = fragment.createSpan({ cls: "ut-status-row" });
		// A picture of a task, not a control: no focus, no taps (they go to the menu item).
		const preview = row.createDiv({ cls: ["ut-status-preview", "markdown-preview-view", "markdown-rendered"], attr: { inert: "" } });
		const item = preview
			.createEl("ul", { cls: "contains-task-list" })
			.createEl("li", { cls: checked ? ["task-list-item", "is-checked"] : "task-list-item", attr: { "data-task": status.char } });
		const box = item.createEl("input", {
			type: "checkbox",
			cls: "task-list-item-checkbox",
			attr: { "data-task": status.char, tabindex: "-1", "aria-hidden": "true" },
		});
		box.checked = checked;
		item.appendText(status.name);
		row.createSpan({ cls: "ut-status-char", text: `[${status.char}]` });
	});
}
