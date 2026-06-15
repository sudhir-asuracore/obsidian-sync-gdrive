import { App, Modal, TFile, Notice, ButtonComponent } from 'obsidian';
import { MergeView } from "@codemirror/merge";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Transaction } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";

export interface Conflict {
	path: string;
	conflictedPath: string;
}

export class ConflictResolveModal extends Modal {
	private conflicts: Conflict[];
	private currentIndex: number = 0;
	private leftMergeView: MergeView | null = null;
	private rightMergeView: MergeView | null = null;
	private isSyncing: boolean = false;

	constructor(app: App, conflicts: Conflict[]) {
		super(app);
		this.conflicts = conflicts;
	}

	async onOpen() {
		this.modalEl.style.width = '95vw';
		this.modalEl.style.maxWidth = '1400px';
		this.render();
	}

	private async render() {
		const { contentEl } = this;
		contentEl.empty();

		if (this.conflicts.length === 0) {
			contentEl.createEl('h2', { text: 'No conflicts to resolve' });
			const closeButton = contentEl.createEl('button', { text: 'Close' });
			closeButton.onclick = () => this.close();
			return;
		}

		const currentConflict = this.conflicts[this.currentIndex];

		contentEl.createEl('h2', { text: 'Resolve Conflict' });
		contentEl.createEl('p', { text: `Resolving conflict ${this.currentIndex + 1} of ${this.conflicts.length}: ${currentConflict.path}` });

		const container = contentEl.createDiv({ cls: 'conflict-merge-container' });
		
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.gap = '10px';
		container.style.height = '70vh';

		const labels = container.createDiv({ cls: 'merge-labels' });
		labels.style.display = 'flex';
		labels.style.justifyContent = 'space-between';
		
		const labelStyle = (el: HTMLElement, width: string) => {
			el.style.width = width;
			el.style.textAlign = 'center';
			el.style.fontWeight = 'bold';
		};

		labelStyle(labels.createDiv({ text: 'Local' }), '33%');
		labelStyle(labels.createDiv({ text: 'Merged Result (Editable)' }), '34%');
		labelStyle(labels.createDiv({ text: 'Remote' }), '33%');

		const editorContainer = container.createDiv({ cls: 'merge-editor-container' });
		editorContainer.style.display = 'flex';
		editorContainer.style.flexDirection = 'row';
		editorContainer.style.flexGrow = '1';
		editorContainer.style.overflow = 'hidden';
		editorContainer.style.border = '1px solid var(--background-modifier-border)';
		editorContainer.style.position = 'relative';

		const leftMvContainer = editorContainer.createDiv({ cls: 'merge-left' });
		leftMvContainer.style.width = '67%';
		const rightMvContainer = editorContainer.createDiv({ cls: 'merge-right' });
		rightMvContainer.style.width = '33%';

		const localFile = this.app.vault.getAbstractFileByPath(currentConflict.conflictedPath);
		const remoteFile = this.app.vault.getAbstractFileByPath(currentConflict.path);

		if (!(localFile instanceof TFile) || !(remoteFile instanceof TFile)) {
			const errorEl = contentEl.createEl('p', { text: 'Error: One or both files are missing.' });
			errorEl.style.color = 'var(--text-error)';
			if (this.conflicts.length > 1) {
				new ButtonComponent(contentEl)
					.setButtonText('Next')
					.onClick(() => this.nextConflict());
			}
			return;
		}

		const localContent = (await this.app.vault.read(localFile)).replace(/\r\n/g, '\n');
		const remoteContent = (await this.app.vault.read(remoteFile)).replace(/\r\n/g, '\n');

		const isBinary = this.isBinaryFile(remoteFile);

		if (!isBinary) {
			const syncExtension = (isLeft: boolean) => {
				return EditorView.updateListener.of((update) => {
					if (update.docChanged && !this.isSyncing) {
						this.isSyncing = true;
						if (isLeft && this.rightMergeView) {
							// Left (MV1.b) -> Right (MV2.a)
							this.rightMergeView.a.dispatch({
								changes: update.changes
							});
						} else if (!isLeft && this.leftMergeView) {
							// Right (MV2.a) -> Left (MV1.b)
							this.leftMergeView.b.dispatch({
								changes: update.changes
							});
						}
						this.isSyncing = false;
					}
				});
			};

			const diffConfig = { scanLimit: 200000 };

			this.leftMergeView = new MergeView({
				diffConfig,
				a: {
					doc: localContent,
					extensions: [
						basicSetup,
						markdown(),
						EditorView.lineWrapping,
						EditorView.editable.of(false),
						EditorState.readOnly.of(true)
					]
				},
				b: {
					doc: remoteContent,
					extensions: [
						basicSetup,
						markdown(),
						EditorView.lineWrapping,
						syncExtension(true)
					]
				},
				revertControls: 'a-to-b',
				parent: leftMvContainer
			});

			this.rightMergeView = new MergeView({
				diffConfig,
				a: {
					doc: remoteContent, // Result
					extensions: [
						basicSetup,
						markdown(),
						EditorView.lineWrapping,
						syncExtension(false)
					]
				},
				b: {
					doc: remoteContent, // Remote
					extensions: [
						basicSetup,
						markdown(),
						EditorView.lineWrapping,
						EditorView.editable.of(false),
						EditorState.readOnly.of(true)
					]
				},
				revertControls: 'b-to-a',
				parent: rightMvContainer
			});

			// Sync scrolling for all editors
			const leftA = this.leftMergeView.a;
			const leftB = this.leftMergeView.b;
			const rightA = this.rightMergeView.a;
			const rightB = this.rightMergeView.b;
			
			const allViews = [leftA, leftB, rightA, rightB];
			
			allViews.forEach(view => {
				view.scrollDOM.addEventListener('scroll', () => {
					if (!this.isSyncing) {
						this.isSyncing = true;
						const top = view.scrollDOM.scrollTop;
						const left = view.scrollDOM.scrollLeft;
						allViews.forEach(v => {
							if (v !== view) {
								v.scrollDOM.scrollTop = top;
								v.scrollDOM.scrollLeft = left;
							}
						});
						this.isSyncing = false;
					}
				});
			});

		} else {
			const binaryMsg = editorContainer.createEl('p', { 
				text: 'Binary file detected. Merging is not supported for this file type.'
			});
			binaryMsg.style.padding = '20px';
			binaryMsg.style.textAlign = 'center';
		}

		const buttonContainer = contentEl.createDiv({ cls: 'conflict-button-container' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'space-between';
		buttonContainer.style.marginTop = '20px';

		const leftButtons = buttonContainer.createDiv();
		const rightButtons = buttonContainer.createDiv();

		new ButtonComponent(leftButtons)
			.setButtonText('Keep Local')
			.setTooltip('Use the conflicted copy and delete the current file')
			.onClick(async () => {
				if (isBinary) {
					await this.resolveConflictBinary(currentConflict, localFile);
				} else {
					await this.resolveConflict(currentConflict, localContent);
				}
			});

		new ButtonComponent(leftButtons)
			.setButtonText('Keep Remote')
			.setTooltip('Keep the current file and delete the conflicted copy')
			.onClick(async () => {
				if (isBinary) {
					await this.resolveConflictBinary(currentConflict, remoteFile);
				} else {
					await this.resolveConflict(currentConflict, remoteContent);
				}
			});

		if (!isBinary) {
			new ButtonComponent(rightButtons)
				.setButtonText('Save Merge')
				.setTooltip('Save the changes made in the center panels and delete the conflicted copy')
				.setCta()
				.onClick(async () => {
					const mergedContent = this.leftMergeView?.b.state.doc.toString();
					if (mergedContent !== undefined) {
						await this.resolveConflict(currentConflict, mergedContent);
					}
				});
		}

		if (this.conflicts.length > 1) {
			new ButtonComponent(rightButtons)
				.setButtonText('Next')
				.onClick(() => {
					this.nextConflict();
				});
		}
	}

	private async resolveConflict(conflict: Conflict, content: string) {
		try {
			const originalFile = this.app.vault.getAbstractFileByPath(conflict.path);
			const conflictedFile = this.app.vault.getAbstractFileByPath(conflict.conflictedPath);

			if (originalFile instanceof TFile) {
				await this.app.vault.modify(originalFile, content);
			} else {
				await this.app.vault.create(conflict.path, content);
			}

			if (conflictedFile instanceof TFile) {
				await this.app.vault.delete(conflictedFile);
			}

			new Notice(`Resolved conflict for ${conflict.path}`);
			
			this.conflicts.splice(this.currentIndex, 1);
			if (this.conflicts.length === 0) {
				this.close();
			} else {
				if (this.currentIndex >= this.conflicts.length) {
					this.currentIndex = 0;
				}
				this.render();
			}
		} catch (e: any) {
			new Notice(`Error resolving conflict: ${e.message}`);
		}
	}

	private async resolveConflictBinary(conflict: Conflict, fileToKeep: TFile) {
		try {
			const originalFile = this.app.vault.getAbstractFileByPath(conflict.path);
			const conflictedFile = this.app.vault.getAbstractFileByPath(conflict.conflictedPath);

			if (fileToKeep.path === conflict.conflictedPath) {
				// Keep Local: Overwrite original with conflicted copy
				const content = await this.app.vault.readBinary(fileToKeep);
				if (originalFile instanceof TFile) {
					await this.app.vault.modifyBinary(originalFile, content);
				} else {
					await this.app.vault.createBinary(conflict.path, content);
				}
			} else {
				// Keep Remote: Nothing to do to the original file, it already has the remote content
			}

			// Delete conflicted copy
			if (conflictedFile instanceof TFile) {
				await this.app.vault.delete(conflictedFile);
			}

			new Notice(`Resolved conflict for ${conflict.path}`);
			
			this.conflicts.splice(this.currentIndex, 1);
			if (this.conflicts.length === 0) {
				this.close();
			} else {
				if (this.currentIndex >= this.conflicts.length) {
					this.currentIndex = 0;
				}
				this.render();
			}
		} catch (e: any) {
			new Notice(`Error resolving conflict: ${e.message}`);
		}
	}

	private isBinaryFile(file: TFile): boolean {
		const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'tif', 'tiff', 'heic', 'heif']);
		const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'opus', 'aiff']);
		const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', '3gp']);
		const ext = file.extension.toLowerCase();
		return IMAGE_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || ext === 'pdf';
	}

	private nextConflict() {
		this.currentIndex = (this.currentIndex + 1) % this.conflicts.length;
		this.render();
	}

	onClose() {
		if (this.leftMergeView) {
			this.leftMergeView.destroy();
			this.leftMergeView = null;
		}
		if (this.rightMergeView) {
			this.rightMergeView.destroy();
			this.rightMergeView = null;
		}
		const { contentEl } = this;
		contentEl.empty();
	}
}
