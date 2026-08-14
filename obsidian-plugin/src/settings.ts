import { App, PluginSettingTab, Setting } from 'obsidian';

import type { BackendId } from './types';
import type ChorusPlugin from './main';

/** Everything configurable, persisted to the plugin's `data.json`. */
export interface ChorusSettings {
  backend: BackendId;

  /** Self-hosted Chorus deployment. */
  chorusBaseUrl: string;
  chorusRegion: string;
  chorusClientId: string;
  chorusUsername: string;
  chorusPassword: string;
  chorusModelId: string;

  /** Amazon Bedrock, signed locally. */
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken: string;
  bedrockModelId: string;

  /** Anthropic's own API. */
  anthropicApiKey: string;
  anthropicModelId: string;

  /** Shared behaviour. */
  systemPrompt: string;
  maxTokens: number;
  showUsage: boolean;
  /**
   * Whether a chat belongs to a note or to the whole vault.
   *
   * Note-scoped chats are pointed to from the note's frontmatter, so they survive
   * renames and moves.
   */
  chatScope: 'note' | 'vault';
}

/**
 * Sonnet is the default everywhere: it is the best value of the current Claude
 * line for note-taking work, and cheap enough that an accidental long thread is
 * not painful. Every field that could hold a secret ships empty.
 */
export const DEFAULT_SETTINGS: ChorusSettings = {
  backend: 'anthropic',

  chorusBaseUrl: '',
  chorusRegion: 'us-east-1',
  chorusClientId: '',
  chorusUsername: '',
  chorusPassword: '',
  chorusModelId: 'claude-sonnet-4-5',

  awsRegion: 'us-east-1',
  awsAccessKeyId: '',
  awsSecretAccessKey: '',
  awsSessionToken: '',
  // Claude 4.x has no on-demand throughput, so an inference profile prefix is
  // mandatory. `global.` bills at list price; `us.` adds roughly 10%.
  bedrockModelId: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',

  anthropicApiKey: '',
  anthropicModelId: 'claude-sonnet-4-5-20250929',

  systemPrompt:
    'You are a concise assistant embedded in an Obsidian vault. Prefer short, direct answers. Use Markdown.',
  maxTokens: 4096,
  showUsage: true,
  chatScope: 'note',
};

/** Settings UI. Only the selected backend's fields are shown, to cut noise. */
export class ChorusSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ChorusPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const settings = this.plugin.settings;

    new Setting(containerEl)
      .setName('Backend')
      .setDesc(
        'Anthropic API is the quickest to set up. Bedrock uses an AWS key. Chorus proxy keeps AWS keys off this device entirely.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('anthropic', 'Anthropic API key')
          .addOption('bedrock', 'Amazon Bedrock (AWS key)')
          .addOption('chorus', 'Chorus proxy (Cognito)')
          .setValue(settings.backend)
          .onChange(async (value) => {
            settings.backend = value as BackendId;
            await this.plugin.saveSettings();
            // Redraw so the irrelevant sections disappear.
            this.display();
          }),
      );

    const warning = containerEl.createDiv({ cls: 'chorus-settings-warning' });
    warning.setText(
      'Credentials entered here are stored unencrypted in this vault\'s plugin folder, and will sync wherever the vault syncs. Prefer a key scoped to only the model access you need.',
    );

    if (settings.backend === 'anthropic') {
      this.section('Anthropic');
      this.secret(
        'API key',
        'From console.anthropic.com. Stored in this vault.',
        () => settings.anthropicApiKey,
        (value) => {
          settings.anthropicApiKey = value;
        },
      );
      this.text(
        'Model',
        'For example claude-sonnet-4-5-20250929.',
        () => settings.anthropicModelId,
        (value) => {
          settings.anthropicModelId = value;
        },
      );
    }

    if (settings.backend === 'bedrock') {
      this.section('Amazon Bedrock');
      this.text(
        'Region',
        'Must be a region where the model is enabled.',
        () => settings.awsRegion,
        (value) => {
          settings.awsRegion = value;
        },
      );
      this.secret(
        'Access key ID',
        '',
        () => settings.awsAccessKeyId,
        (value) => {
          settings.awsAccessKeyId = value;
        },
      );
      this.secret(
        'Secret access key',
        '',
        () => settings.awsSecretAccessKey,
        (value) => {
          settings.awsSecretAccessKey = value;
        },
      );
      this.secret(
        'Session token',
        'Only needed for temporary credentials.',
        () => settings.awsSessionToken,
        (value) => {
          settings.awsSessionToken = value;
        },
      );
      this.text(
        'Model ID',
        'Claude 4.x needs an inference profile prefix, such as global. or us.',
        () => settings.bedrockModelId,
        (value) => {
          settings.bedrockModelId = value;
        },
      );
    }

    if (settings.backend === 'chorus') {
      this.section('Chorus proxy');
      this.text(
        'Base URL',
        'For example https://chat.example.com.',
        () => settings.chorusBaseUrl,
        (value) => {
          settings.chorusBaseUrl = value;
        },
      );
      this.text(
        'Cognito region',
        '',
        () => settings.chorusRegion,
        (value) => {
          settings.chorusRegion = value;
        },
      );
      this.text(
        'App client ID',
        'Must be a client that allows USER_PASSWORD_AUTH.',
        () => settings.chorusClientId,
        (value) => {
          settings.chorusClientId = value;
        },
      );
      this.text(
        'Username',
        '',
        () => settings.chorusUsername,
        (value) => {
          settings.chorusUsername = value;
        },
      );
      this.secret(
        'Password',
        '',
        () => settings.chorusPassword,
        (value) => {
          settings.chorusPassword = value;
        },
      );
      this.text(
        'Model',
        "The model key as your Chorus deployment names it, such as claude-sonnet-4-5.",
        () => settings.chorusModelId,
        (value) => {
          settings.chorusModelId = value;
        },
      );
    }

    this.section('Behaviour');

    new Setting(containerEl)
      .setName('System prompt')
      .setDesc('Sent with every request. Leave empty to send none.')
      .addTextArea((area) => {
        area.setValue(settings.systemPrompt).onChange(async (value) => {
          settings.systemPrompt = value;
          await this.plugin.saveSettings();
        });
        area.inputEl.rows = 4;
        area.inputEl.addClass('chorus-settings-textarea');
      });

    new Setting(containerEl)
      .setName('Maximum reply tokens')
      .setDesc('Caps the length, and therefore the cost, of a single reply.')
      .addText((text) =>
        text.setValue(String(settings.maxTokens)).onChange(async (value) => {
          const parsed = Number(value);
          // Ignore nonsense rather than persisting a value that breaks requests.
          if (Number.isFinite(parsed) && parsed > 0) {
            settings.maxTokens = Math.floor(parsed);
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('Chat scope')
      .setDesc(
        'A chat per note, or one chat for the whole vault. Note chats are recorded in the note\'s frontmatter, and are only created once a reply arrives.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('note', 'One chat per note')
          .addOption('vault', 'One chat for the vault')
          .setValue(settings.chatScope)
          .onChange(async (value) => {
            settings.chatScope = value as 'note' | 'vault';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Show token usage')
      .setDesc('Reveals tokens and an estimated cost under each reply on hover.')
      .addToggle((toggle) =>
        toggle.setValue(settings.showUsage).onChange(async (value) => {
          settings.showUsage = value;
          await this.plugin.saveSettings();
        }),
      );
  }

  private section(title: string): void {
    this.containerEl.createEl('h3', { text: title });
  }

  private text(
    name: string,
    description: string,
    read: () => string,
    write: (value: string) => void,
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) =>
        text.setValue(read()).onChange(async (value) => {
          write(value.trim());
          await this.plugin.saveSettings();
        }),
      );
  }

  /** Same as `text`, but masks the field so a shoulder-surfer sees nothing. */
  private secret(
    name: string,
    description: string,
    read: () => string,
    write: (value: string) => void,
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setValue(read()).onChange(async (value) => {
          write(value.trim());
          await this.plugin.saveSettings();
        });
      });
  }
}
