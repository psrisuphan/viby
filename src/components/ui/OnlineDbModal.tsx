// Copyright (c) 2026 Bukutsu
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useRef, useState } from "react";
import { X, Download, Trash2, Search, Plus, Loader2 } from "lucide-react";
import { useToastStore } from "../../stores/toastStore";
import CustomScrollbar from "./CustomScrollbar";
import {
	isDatabaseDownloaded,
	clearCachedDatabase,
	downloadDatabase,
	fetchManifest,
	loadDeviceCurvePoints,
	type OnlineDevice,
} from "../../utils/onlineDb";
import { addHeadphoneMeasurement } from "../../utils/tauri";
import "./OnlineDbModal.css";

interface Props {
	isOpen: boolean;
	onClose: () => void;
	onMeasurementAdded: () => void;
}

export default function OnlineDbModal({ isOpen, onClose, onMeasurementAdded }: Props) {
	const [downloaded, setDownloaded] = useState(false);
	const [isDownloading, setIsDownloading] = useState(false);
	const [progress, setProgress] = useState(0);
	const [manifest, setManifest] = useState<OnlineDevice[]>([]);
	const [loadingManifest, setLoadingManifest] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [importingId, setImportingId] = useState<string | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const checkDatabase = async () => {
		const isDbDownloaded = await isDatabaseDownloaded();
		setDownloaded(isDbDownloaded);
		if (isDbDownloaded) {
			loadManifest();
		}
	};

	const loadManifest = async () => {
		setLoadingManifest(true);
		try {
			const devices = await fetchManifest();
			setManifest(devices);
		} catch (err) {
			console.error("Failed to load search manifest:", err);
			useToastStore.getState().addToast("Failed to load search manifest", "error");
		} finally {
			setLoadingManifest(false);
		}
	};

	useEffect(() => {
		if (isOpen) {
			checkDatabase();
		}
	}, [isOpen]);

	useEffect(() => {
		if (isOpen && downloaded) {
			// Focus input on mount/download complete
			setTimeout(() => inputRef.current?.focus(), 50);
		}
	}, [isOpen, downloaded]);

	if (!isOpen) return null;

	const handleDownload = async () => {
		setIsDownloading(true);
		setProgress(0);
		try {
			await downloadDatabase((percent) => {
				setProgress(percent);
			});
			setDownloaded(true);
			await loadManifest();
			useToastStore.getState().addToast("Database downloaded successfully", "success");
		} catch (err: any) {
			console.error(err);
			useToastStore.getState().addToast(err.toString() || "Failed to download database", "error");
		} finally {
			setIsDownloading(false);
		}
	};

	const handleClearCache = async () => {
		if (window.confirm("Are you sure you want to delete the cached online database (approx. 16MB)?")) {
			try {
				await clearCachedDatabase();
				setDownloaded(false);
				setManifest([]);
				setSearchQuery("");
				useToastStore.getState().addToast("Cache cleared successfully", "success");
			} catch (err: any) {
				useToastStore.getState().addToast("Failed to clear cache", "error");
			}
		}
	};

	const handleImport = async (dev: OnlineDevice) => {
		setImportingId(dev.id);
		try {
			const points = await loadDeviceCurvePoints(dev.id);
			const name = `${dev.brand} ${dev.name} (${dev.source})`;
			await addHeadphoneMeasurement(name, points);
			onMeasurementAdded();
			useToastStore.getState().addToast(`Imported ${dev.brand} ${dev.name}`, "success");
		} catch (err: any) {
			console.error(err);
			useToastStore.getState().addToast("Failed to import curve", "error");
		} finally {
			setImportingId(null);
		}
	};

	const searchTokens = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const filteredDevices = searchTokens.length === 0
		? []
		: manifest.filter((dev) => {
				const full = `${dev.brand} ${dev.name}`.toLowerCase();
				return searchTokens.every((token) => full.includes(token));
			});

	const displayDevices = filteredDevices.slice(0, 50);

	return (
		<div className="modal-overlay animate-fade-in" onClick={onClose}>
			<div
				className="search-modal animate-scale-in glass-panel-heavy"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="search-header">
					<Search size={20} className="search-icon" />
					{!downloaded ? (
						<>
							<span style={{ flex: 1, fontSize: "var(--font-size-md)", fontWeight: 500, color: "var(--text-primary)" }}>
								Online Measurements Database
							</span>
							<button className="icon-btn" onClick={onClose}>
								<X size={20} />
							</button>
						</>
					) : (
						<>
							<input
								ref={inputRef}
								type="text"
								placeholder="Search brand, model, or source..."
								className="search-input"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
							/>
							<button
								className="online-db-clear-cache-btn"
								onClick={handleClearCache}
								title="Clear Cached Database"
								style={{ marginRight: "var(--space-sm)" }}
							>
								<Trash2 size={16} />
							</button>
							<button className="icon-btn" onClick={onClose}>
								<X size={20} />
							</button>
						</>
					)}
				</div>

				<div className="search-results-wrapper scrollbar-host">
					{!downloaded ? (
						<div className="online-db-setup">
							<p className="online-db-desc">
								Download the PEQHUB Squig-Rank database to search and import thousands of headphone and IEM measurements offline. The download size is approximately 16MB.
							</p>
							{isDownloading ? (
								<div className="online-db-download-progress">
									<div className="online-db-progress-bar-container">
										<div
											className="online-db-progress-bar"
											style={{ width: `${progress * 100}%` }}
										/>
									</div>
									<span className="online-db-progress-text">
										Downloading... {Math.round(progress * 100)}%
									</span>
								</div>
							) : (
								<button className="online-db-download-btn" onClick={handleDownload}>
									<Download size={16} />
									<span>Download Database</span>
								</button>
							)}
						</div>
					) : loadingManifest ? (
						<div className="empty-state">
							<Loader2 className="animate-spin" size={24} />
							<p>Loading database manifest...</p>
						</div>
					) : (
						<div className="search-results" ref={listRef}>
							{searchQuery.trim() === "" ? (
								<div className="empty-state" style={{ padding: "var(--space-2xl) 0" }}>
									<p>Type above to search over {manifest.length} headphone and IEM curves</p>
								</div>
							) : displayDevices.length === 0 ? (
								<div className="empty-state" style={{ padding: "var(--space-2xl) 0" }}>
									<p>No matching measurements found</p>
								</div>
							) : (
								<div className="search-sections">
									<div className="search-section" style={{ marginTop: "var(--space-sm)" }}>
										<h3>Devices</h3>
										<div className="search-list">
											{displayDevices.map((dev) => (
												<div key={dev.id} className="search-item" style={{ cursor: "default" }}>
													<div className="search-item-info">
														<div className="search-item-title truncate">
															{dev.brand} {dev.name}
														</div>
														<div className="search-item-subtitle truncate">
															{dev.source}{dev.price ? ` • $${dev.price}` : ""}
														</div>
													</div>
													<button
														className="online-device-import-btn"
														onClick={() => handleImport(dev)}
														disabled={importingId !== null}
													>
														{importingId === dev.id ? (
															<Loader2 className="animate-spin" size={14} />
														) : (
															<Plus size={14} />
														)}
														<span>Import</span>
													</button>
												</div>
											))}
										</div>
									</div>
								</div>
							)}
							<CustomScrollbar scrollRef={listRef} />
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
