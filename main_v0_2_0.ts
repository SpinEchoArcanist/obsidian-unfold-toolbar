import { App, Editor, Platform, Plugin, PluginSettingTab, Setting, addIcon, debounce, removeIcon } from "obsidian";

interface UnfoldToolbarSettings {
	rowsPhonePortrait: number;
	rowsPhoneLandscape: number;
	rowsTablet: number;
	startFolded: boolean;
}

type RowsKey = "rowsPhonePortrait" | "rowsPhoneLandscape" | "rowsTablet";

const DEFAULT_SETTINGS: UnfoldToolbarSettings = {
	rowsPhonePortrait: 4,
	rowsPhoneLandscape: 2,
	rowsTablet: 4,
	startFolded: true,
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

const CSS_PROPS = [
	...Object.values(ROW_LAYOUTS).flatMap(({ cssKey }) => [`--ut-list-${cssKey}`, `--ut-toolbar-${cssKey}`]),
	BUTTONS_PROP,
];

export default class UnfoldToolbarPlugin extends Plugin {
	settings: UnfoldToolbarSettings = { ...DEFAULT_SETTINGS };
	private scrollFrame: number | null = null;
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
			if (document.body.hasClass(UNFOLDED_CLASS)) this.relayoutAfterResize();
		});

		if (!this.settings.startFolded && this.app.loadLocalStorage(STATE_KEY) === true) {
			document.body.addClass(UNFOLDED_CLASS);
		}

		// Fold back when Obsidian closes the toolbar, if the user wants a fresh start each time.
		let wasOpen = document.body.hasClass(TOOLBAR_OPEN_CLASS);
		const observer = new MutationObserver(() => {
			const isOpen = document.body.hasClass(TOOLBAR_OPEN_CLASS);
			// Obsidian rebuilds the buttons just before it opens the toolbar.
			if (isOpen && !wasOpen) this.countButtons();
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
		document.body.removeClass(UNFOLDED_CLASS);
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
		this.settings = {
			rowsPhonePortrait: rows("rowsPhonePortrait"),
			rowsPhoneLandscape: rows("rowsPhoneLandscape"),
			rowsTablet: rows("rowsTablet"),
			startFolded: typeof merged.startFolded === "boolean" ? merged.startFolded : DEFAULT_SETTINGS.startFolded,
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		if (Platform.isMobile) this.applyHeights();
	}

	/** Called when "Start folded" changes: keep or drop this device's remembered state. */
	onStartFoldedChanged(): void {
		if (!Platform.isMobile) return;
		this.app.saveLocalStorage(STATE_KEY, this.settings.startFolded ? null : document.body.hasClass(UNFOLDED_CLASS));
	}

	private toggle(editor: Editor): void {
		this.setUnfolded(!document.body.hasClass(UNFOLDED_CLASS));
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
		if (!document.body.hasClass(UNFOLDED_CLASS)) return;
		document.body.removeClass(UNFOLDED_CLASS);
		document.body.getBoundingClientRect();
		document.body.addClass(UNFOLDED_CLASS);
		const frame = document.body.querySelector(".mobile-toolbar-options-list-container");
		if (frame) frame.scrollLeft = 0;
	}

	private setUnfolded(unfolded: boolean): void {
		if (unfolded) this.countButtons();
		document.body.toggleClass(UNFOLDED_CLASS, unfolded);
		if (!this.settings.startFolded) this.app.saveLocalStorage(STATE_KEY, unfolded);
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
	}
}

class UnfoldToolbarSettingTab extends PluginSettingTab {
	private readonly plugin: UnfoldToolbarPlugin;

	constructor(app: App, plugin: UnfoldToolbarPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Rows when unfolded").setHeading();
		this.addRowsSetting("Phone, portrait", "", "rowsPhonePortrait");
		this.addRowsSetting(
			"Phone, landscape",
			"The keyboard takes most of the screen here. Choose 1 row to keep the toolbar folded.",
			"rowsPhoneLandscape"
		);
		this.addRowsSetting("Tablet", "Used in both orientations.", "rowsTablet");

		new Setting(containerEl).setName("Behavior").setHeading();
		new Setting(containerEl)
			.setName("Start folded")
			.setDesc(
				"The toolbar opens as a single row each time you start editing. Turn off to keep it the way you left it on this device."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.startFolded).onChange(async (value) => {
					this.plugin.settings.startFolded = value;
					await this.plugin.saveSettings();
					this.plugin.onStartFoldedChanged();
				})
			);
	}

	private addRowsSetting(name: string, desc: string, key: RowsKey): void {
		const setting = new Setting(this.containerEl).setName(name);
		if (desc) setting.setDesc(desc);
		setting.addDropdown((dropdown) => {
			for (const rows of ROW_LAYOUTS[key].choices) {
				dropdown.addOption(String(rows), rows === 1 ? "1 row" : `${rows} rows`);
			}
			dropdown.setValue(String(this.plugin.settings[key])).onChange(async (value) => {
				this.plugin.settings[key] = Number(value);
				await this.plugin.saveSettings();
			});
		});
	}
}
