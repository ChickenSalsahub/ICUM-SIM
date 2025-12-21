
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
import os

# Set style for academic paper
sns.set_theme(style="whitegrid", context="paper", font_scale=1.2)
plt.rcParams['figure.figsize'] = [8, 5]
plt.rcParams['lines.linewidth'] = 2.0

OUTPUT_DIR = "paper_figures"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def save_plot(name):
    path = os.path.join(OUTPUT_DIR, f"{name}.png")
    plt.tight_layout()
    plt.savefig(path, dpi=300)
    print(f"Saved {path}")
    plt.close()

def plot_experiment_a():
    """Distributed vs Baseline Performance"""
    try:
        df = pd.read_csv("experiments_A_all.csv")
        # Filter for the canonical scenario
        df = df[(df["scenario"] == "few_moving") & (df["noise_sigma"] == 0.1)]
        
        plt.figure()
        plt.plot(df["time_s"], df["baseline_rmse_aligned_m"], label="Baseline (Periodic)", linestyle="--", alpha=0.7)
        plt.plot(df["time_s"], df["icum_rmse_aligned_m"], label="Distributed (Event-Triggered)", color="#d62728")
        
        plt.xlabel("Time (s)")
        plt.ylabel("Aligned RMSE (m)")
        plt.title("Convergence Speed: Distributed vs Baseline\n(10% Moving, 0.1m Noise)")
        plt.legend()
        # plt.ylim(0, 1.0) # Focus on the convergence area (Removed for auto-scale)
        save_plot("ExpA_Convergence")

        # Energy Plot
        plt.figure()
        # Calculate cumulative TX if not already? It is cumulative in CSV.
        plt.plot(df["time_s"], df["baseline_tx_total"], label="Baseline Tx", linestyle="--")
        plt.plot(df["time_s"], df["icum_tx_total"], label="ETM Tx", color="green")
        plt.xlabel("Time (s)")
        plt.ylabel("Total Packets Sent")
        plt.title("Network Load: Time-Triggered vs Event-Triggered")
        plt.legend()
        save_plot("ExpA_Energy")
        
    except FileNotFoundError:
        print("Skipping Exp A: File not found")

def plot_experiment_b():
    """Baseline Limits"""
    try:
        df = pd.read_csv("experiments_B_summary_clean.csv")
        
        plt.figure()
        plt.errorbar(
            df["uwb_sigma_m"], 
            df["rmse_aligned_median_m"], 
            yerr=[
                df["rmse_aligned_median_m"] - df["rmse_aligned_p25_m"], 
                df["rmse_aligned_p75_m"] - df["rmse_aligned_median_m"]
            ], 
            fmt='-o', capsize=5
        )
        plt.xlabel("UWB Noise $\sigma$ (m)")
        plt.ylabel("Aligned RMSE (m)")
        plt.title("Theoretical Lower Bound (CRLB Proxy)")
        plt.grid(True, linestyle="--", alpha=0.5)
        save_plot("ExpB_LowerBound")
    except FileNotFoundError:
        print("Skipping Exp B: File not found")

def plot_experiment_c():
    """Scalability"""
    try:
        df = pd.read_csv("experiments_C_all.csv")
        
        # Plot 2 subplots: Static vs Dynamic
        fig, axes = plt.subplots(1, 2, figsize=(12, 5), sharey=True)
        
        scenarios = [("none_moving", "Static (No Motion)"), ("many_moving", "Dynamic (Mobility)")]
        node_counts = sorted(df["node_count"].unique())
        
        for ax, (scen_key, title) in zip(axes, scenarios):
            subset_scen = df[df["scenario"] == scen_key]
            if subset_scen.empty:
                print(f"Warning: No data for {scen_key}")
                continue
                
            # Use sns.lineplot for automatic aggregation (mean + 95% CI)
            sns.lineplot(
                data=subset_scen, 
                x="time_s", 
                y="rmse_m", 
                hue="node_count", 
                palette="viridis", 
                ax=ax,
                errorbar='ci', # default is 95% CI
                legend=(ax == axes[0]) # Only show legend once (or fix location later)
            )
            
            ax.set_xlabel("Time (s)")
            ax.set_title(title)
            ax.set_yscale("log")
            ax.grid(True, which="both", ls="--", alpha=0.5)

        axes[0].set_ylabel("Aligned RMSE (m)")
        # Clean up legend
        if axes[0].get_legend():
            axes[0].get_legend().remove()
        
        # Add common legend to the right
        handles, labels = axes[0].get_legend_handles_labels()
        # Filter duplicates if any
        by_label = dict(zip(labels, handles))
        fig.legend(by_label.values(), by_label.keys(), title="Nodes", loc='center right', bbox_to_anchor=(0.98, 0.5))
        plt.subplots_adjust(right=0.85)
        
        plt.suptitle("Scalability Limit: Impact of Mobility on Convergence (Mean $\pm$ 95\% CI)")
        # plt.tight_layout() # Conflict with subplot_adjust
        save_plot("ExpC_Scalability")

    except FileNotFoundError:
        print("Skipping Exp C: File not found")

def main():
    print("Generating paper figures...")
    plot_experiment_a()
    plot_experiment_b()
    plot_experiment_c()
    print(f"Done! Figures saved to ./{OUTPUT_DIR}/")

if __name__ == "__main__":
    main()
