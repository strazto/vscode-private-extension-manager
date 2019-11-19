import * as _glob from 'glob';
import * as path from 'path';
import { parse as parseVersion, SemVer } from 'semver';
import { promisify } from 'util';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';

import { getExtension } from './extensionInfo';
import { Registry } from './Registry';
import { isNonEmptyArray } from './util';

const README_GLOB = 'README?(.*)';
const CHANGELOG_GLOB = 'CHANGELOG?(.*)';

const glob = promisify(_glob);
const localize = nls.loadMessageBundle();

export enum PackageState {
    /** The extension is available to be installed. */
    Available = 'available',
    /** The latest version of the extension is already installed in the local machine. */
    Installed = 'installed',
    /** The latest version of the extension is already installed in the remote machine. */
    InstalledRemote = 'installed.remote',
    /** The extension is installed and a newer version is available. */
    UpdateAvailable = 'update',
    /** The package is not a valid extension. */
    Invalid = 'invalid',
}

/**
 * Error thrown when constructing a `Package` from a package manifest that is
 * not a Visual Studio Code extension.
 */
export class NotAnExtensionError extends Error {}

/**
 * Represents an NPM package for an extension.
 */
export class Package {
    /**
     * Comparison function to sort packages by name in alphabetical order.
     */
    public static compare(a: Package, b: Package) {
        const nameA = a.displayName.toUpperCase();
        const nameB = b.displayName.toUpperCase();

        return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
    }

    /** The package name. */
    public readonly name: string;
    /** The ID of the extension in the form `publisher.name`. */
    public readonly extensionId: string;
    /** The name to display for the package in the UI. */
    public readonly displayName: string;
    /** A short description for the package. */
    public readonly description: string;
    /** The package version. */
    public readonly version: SemVer;
    /** The registry containing the extension. */
    public readonly registry: Registry;

    private readonly vsixFile: string | null;
    private readonly _publisher?: string;

    private _isInstalled = false;
    private _isUiExtension = false;
    private _installedVersion: SemVer | null = null;
    private _installedExtensionKind: vscode.ExtensionKind | undefined;

    /**
     * @param registry The `Registry` that contains the package.
     * @param manifest The version-specific package manifest for the extension.
     * @throws {NotAnExtensionError} `manifest` is not a Visual Studio Code extension.
     */
    constructor(registry: Registry, manifest: Record<string, unknown>) {
        this.registry = registry;

        if (typeof manifest.engines !== 'object' || manifest.engines === null || !('vscode' in manifest.engines)) {
            throw new NotAnExtensionError('Package is not an extension');
        }

        if (typeof manifest.name !== 'string') {
            throw new TypeError('Package name is mising');
        }

        this.name = manifest.name;

        if (typeof manifest.displayName === 'string') {
            this.displayName = manifest.displayName;
        } else {
            this.displayName = this.name;
        }

        if (typeof manifest.publisher === 'string') {
            this._publisher = manifest.publisher;
        }

        if (typeof manifest.description === 'string') {
            this.description = manifest.description;
        } else {
            this.description = this.name;
        }

        if (typeof manifest.version === 'string') {
            this.version = parseVersion(manifest.version) ?? new SemVer('0.0.0');
        } else {
            this.version = new SemVer('0.0.0');
        }

        // VS Code uses case-insensitive comparison to match extension IDs.
        // Match that behavior by normalizing everything to lowercase.
        this.extensionId = `${this.publisher}.${this.name}`.toLowerCase();

        // Attempt to infer from the manifest where the extension will be
        // installed. This is overridden by the actual install location later
        // if the extension is already installed.
        this._isUiExtension = isUiExtension(this.extensionId, manifest);

        this.vsixFile = findVsixFile(manifest);
    }

    /**
     * Checks if the extension is installed, and updates the state to match the
     * installed version.
     */
    public async updateState() {
        const extension = await getExtension(this.extensionId);
        if (extension) {
            this._isInstalled = true;
            this._installedExtensionKind = extension.extensionKind;
            this._installedVersion = extension.version;
        } else {
            this._isInstalled = false;
            this._installedExtensionKind = undefined;
            this._installedVersion = null;
        }
    }

    /**
     * A value that represents the state of the extension.
     *
     * Call `updateState()` first to ensure this is up-to-date.
     */
    public get state() {
        if (this._publisher && this.vsixFile) {
            if (this.isUpdateAvailable) {
                return PackageState.UpdateAvailable;
            } else if (this.isInstalled) {
                return this.isUiExtension ? PackageState.Installed : PackageState.InstalledRemote;
            } else {
                return PackageState.Available;
            }
        } else {
            return PackageState.Invalid;
        }
    }

    /**
     * The name of the package publisher.
     */
    public get publisher() {
        return this._publisher ?? localize('publisher.unknown', 'Unknown');
    }

    /**
     * The NPM package specifier for the package.
     */
    public get spec() {
        return `${this.name}@${this.version}`;
    }

    /**
     * If `state` is `PackageState.Invalid`, gets a string explaining why the
     * package is invalid.
     */
    public get errorMessage() {
        if (!this._publisher) {
            return localize('manifest.missing.publisher', 'Manifest is missing "publisher" field.');
        }
        if (!this.vsixFile) {
            return localize('manifest.missing.vsix', 'Manifest is missing .vsix file in "files" field.');
        }
        return '';
    }

    /**
     * Is the extension installed?
     *
     * Call `updateState()` first to ensure this is up-to-date.
     */
    public get isInstalled() {
        return this._isInstalled;
    }

    /**
     * If `isInstalled`, the version of extension that is installed, or `null` otherwise.
     *
     * Call `updateState()` first to ensure this is up-to-date.
     */
    public get installedVersion() {
        return this._installedVersion;
    }

    /**
     * If `true`, this extension runs on the same machine where the UI runs.
     * If `false`, it runs where the remote extension host runs.
     *
     * Call `updateState()` first to ensure this is up-to-date.
     */
    public get isUiExtension() {
        if (this._installedExtensionKind !== undefined) {
            return this._installedExtensionKind === vscode.ExtensionKind.UI;
        } else {
            return this._isUiExtension;
        }
    }

    /**
     * Gets whether this package represents a newer version of the extension
     * than the version that is installed.
     *
     * Call `updateState()` first to ensure this is up-to-date.
     */
    public get isUpdateAvailable(): boolean {
        return !!this.installedVersion && this.version > this.installedVersion;
    }

    public toString() {
        return this.displayName;
    }

    /**
     * Downloads the package and returns the locations of its package manifest,
     * readme, changelog, and .vsix file.
     */
    public async getContents() {
        const directory = await this.registry.downloadPackage(this);

        return {
            manifest: uriJoin(directory, 'package.json'),
            vsix: this.vsixFile ? uriJoin(directory, this.vsixFile) : null,
            readme: await findFile(directory, README_GLOB),
            changelog: await findFile(directory, CHANGELOG_GLOB),
        };
    }
}

function uriJoin(directory: vscode.Uri, file: string) {
    return vscode.Uri.file(path.join(directory.fsPath, file));
}

function findVsixFile(manifest: Record<string, any>) {
    if (Array.isArray(manifest.files)) {
        for (const file of manifest.files) {
            if (typeof file === 'string' && file.endsWith('.vsix')) {
                return file;
            }
        }
    }

    return null;
}

/**
 * Searches for a file in a directory using a glob pattern.
 *
 * Returns the first file found, or null if no file was found.
 */
async function findFile(directory: vscode.Uri, pattern: string) {
    const results = await glob(pattern, {
        cwd: directory.fsPath,
        nocase: true,
    });

    if (results.length > 0) {
        const file = path.join(directory.fsPath, results[0]);
        return vscode.Uri.file(file);
    } else {
        return null;
    }
}

// Mirrors https://github.com/microsoft/vscode/blob/master/src/vs/workbench/services/extensions/common/extensionsUtil.ts
function isUiExtension(extensionId: string, manifest: any) {
    // All extensions are UI extensions when not using remote development.
    if (vscode.env.remoteName === undefined) {
        return true;
    }

    const extensionKind = getExtensionKind(extensionId, manifest);
    switch (extensionKind) {
        case 'ui':
            return true;
        case 'workspace':
            return false;
        default: {
            // Not a UI extension if it has main.
            if (manifest.main) {
                return false;
            }

            // Not a UI extension if it has dependencies or an extension pack.
            if (isNonEmptyArray(manifest.extensionDependencies) || isNonEmptyArray(manifest.extensionPack)) {
                return false;
            }

            // TODO: Not a UI extension if it has no UI contributions.
            // (but vscode has no API to check what is a UI contribution.)
            return true;
        }
    }
}

function getExtensionKind(extensionId: string, manifest: any): string | undefined {
    // remote.extensionKind setting overrides manifest:
    // https://code.visualstudio.com/docs/remote/ssh#_advanced-forcing-an-extension-to-run-locally-remotely
    const config = vscode.workspace.getConfiguration().get<Record<string, string>>('remote.extensionKind', {});

    for (const id of Object.keys(config)) {
        if (id.toLowerCase() === extensionId) {
            return config[id];
        }
    }

    if (typeof manifest.extensionKind === 'string') {
        return manifest.extensionKind;
    }

    return undefined;
}
