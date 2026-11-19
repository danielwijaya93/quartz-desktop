"use client";

import "@openuidev/react-ui/styles/index.css";

import { AntigravityAssistantMessage } from "@/components/AntigravityAssistantMessage";
import { AntigravityComposer } from "@/components/AntigravityComposer";
import { AntigravityUserMessage } from "@/components/AntigravityUserMessage";
import { AntigravityDialogs } from "@/components/Dialogs";
import { FolderSidebar } from "@/components/FolderSidebar";
import { NotificationBellButton, NotificationManager } from "@/components/NotificationManager";
import { ThreadAutoRenamer } from "@/components/ThreadAutoRenamer";
import { ThreadRunRecovery } from "@/components/ThreadRunRecovery";
import { ThreadSyncManager } from "@/components/ThreadSyncManager";
import { acpStore, useAcpStore } from "@/lib/client/acp-store";
import { createAntigravityChatBindings } from "@/lib/client/local-storage";
import { useThread } from "@openuidev/react-headless";
import { AgentInterface, useThemeModePreference } from "@openuidev/react-ui";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { BarChart3, Folder, GitBranch, History, ListChecks, Sparkles } from "lucide-react";
import { useEffect, useMemo } from "react";

const STARTERS = [
  {
    displayText: "Workspace Dashboard",
    subtitle: "KPI cards, file breakdown chart & dependencies",
    icon: BarChart3,
    prompt:
      "Inspect this workspace and present a rich dashboard with KPI cards, a table of files/dependencies, and a chart breaking down file types or dependency counts.",
  },
  {
    displayText: "Git & Repo Health",
    subtitle: "Status, recent commits & visual activity summary",
    icon: GitBranch,
    prompt:
      "Run git status and recent git log, then render a repository health dashboard with a table of recent commits and a visual summary.",
  },
  {
    displayText: "Interactive Config Form",
    subtitle: "Build a live form with cards, selects & sliders",
    icon: ListChecks,
    prompt:
      "Create an interactive setup form using OptionCards, Select, Slider, and TextArea to help me configure a new project workflow, and summarize my choices when I submit.",
  },
  {
    displayText: "Use /antigravity-guide",
    subtitle: "Slash commands, skills & MCP setup overview",
    icon: Sparkles,
    prompt:
      "/antigravity-guide Summarize Antigravity CLI slash commands, skills, and MCP configuration in a comparison table and steps card.",
  },
];

function WelcomeHero() {
  const processMessage = useThread((s) => s.processMessage);
  const isRunning = useThread((s) => s.isRunning);
  const folders = useAcpStore((s) => s.folders);
  const activeFolderId = useAcpStore((s) => s.activeFolderId);
  const cwd = useAcpStore((s) => s.cwd);

  const activeFolder = folders.find((f) => f.id === activeFolderId);
  const workspaceLabel = activeFolder?.name || (cwd ? cwd.split("/").filter(Boolean).pop() : "");
  const workspaceTitle = activeFolder?.cwd || cwd;

  return (
    <div className="mx-auto flex w-full max-w-[680px] flex-col items-center justify-center px-6 py-6 text-center">
      {workspaceLabel && (
        <div
          title={workspaceTitle}
          className="mb-3 inline-flex max-w-full items-center gap-1.5 rounded-full border border-black/[0.08] dark:border-white/[0.1] bg-black/[0.02] dark:bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium opacity-75"
        >
          <Folder className="h-3 w-3 shrink-0 opacity-65" aria-hidden="true" />
          <span className="truncate font-mono">{workspaceLabel}</span>
        </div>
      )}
      <h1 className="text-xl font-medium tracking-tight sm:text-2xl">
        Antigravity Generative UI
      </h1>
      <div className="mt-5 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {STARTERS.map((starter) => {
          const Icon = starter.icon;
          return (
            <button
              key={starter.displayText}
              type="button"
              disabled={isRunning}
              onClick={() => void processMessage({ role: "user", content: starter.prompt })}
              className="group flex min-h-[52px] items-start gap-2.5 rounded-xl border border-black/[0.07] dark:border-white/[0.09] bg-black/[0.015] dark:bg-white/[0.025] px-3.5 py-2.5 text-left transition-all hover:border-black/15 dark:hover:border-white/20 hover:bg-black/[0.035] dark:hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/25 dark:focus-visible:ring-white/30 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Icon
                className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60 transition-opacity group-hover:opacity-95"
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium">{starter.displayText}</span>
                <span className="mt-0.5 block truncate text-[11px] opacity-55">
                  {starter.subtitle}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ImportSessionButton({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      aria-label="Import session from current workspace"
      title="Import session from current workspace"
      onClick={() => acpStore.setActiveModal("sessions")}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg opacity-70 transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.08] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/25 dark:focus-visible:ring-white/30 cursor-pointer ${className}`}
    >
      <History className="h-4 w-4 shrink-0" aria-hidden="true" />
    </button>
  );
}

export function AntigravityWorkbench() {
  const { mode, setPreference } = useThemeModePreference();
  const { llm, storage } = useMemo(() => createAntigravityChatBindings(), []);

  useEffect(() => {
    acpStore.hydrateFromStorage();
  }, []);

  useEffect(() => {
    document.documentElement.style.colorScheme = mode;
    document.documentElement.setAttribute("data-openui-theme", mode);
  }, [mode]);

  return (
    <div className="relative h-dvh w-screen overflow-hidden">
      <AgentInterface
        llm={llm}
        storage={storage}
        componentLibrary={openuiLibrary}
        components={{
          AssistantMessage: AntigravityAssistantMessage,
          UserMessage: AntigravityUserMessage,
        }}
        agentName="Antigravity GenUI"
        theme={{ mode }}
      >
        <AgentInterface.Sidebar>
          <div className="openui-agent-sidebar-actions">
            <AgentInterface.SidebarHeader />
            <div className="openui-agent-sidebar-primary-actions">
              <AgentInterface.NewChatButton />
              <AgentInterface.ArtifactNav className="openui-agent-sidebar-artifact-nav" />
            </div>
          </div>

          <AgentInterface.SidebarContent>
            <FolderSidebar />
          </AgentInterface.SidebarContent>

          <AgentInterface.SidebarFooter>
            <div className="antigravity-sidebar-footer-bar flex w-full items-center justify-between border-t border-black/[0.06] dark:border-white/[0.08] px-1 pt-2">
              <div className="antigravity-sidebar-footer-actions flex items-center gap-0.5">
                <ImportSessionButton />
                <NotificationBellButton />
              </div>
              <AgentInterface.ThemeModeToggle mode={mode} onModeChange={setPreference} />
            </div>
          </AgentInterface.SidebarFooter>
        </AgentInterface.Sidebar>

        <AgentInterface.ThreadHeader
          className="!hidden"
          showChatTitle={false}
          showChatActions={false}
        />

        <AgentInterface.MobileHeader
          newChatButton={false}
          actions={
            <div className="flex items-center gap-1">
              <NotificationBellButton />
              <ImportSessionButton />
            </div>
          }
        />

        <AgentInterface.Welcome>
          <WelcomeHero />
        </AgentInterface.Welcome>

        <AgentInterface.Composer>
          <AntigravityComposer />
        </AgentInterface.Composer>

        <AntigravityDialogs />
        <NotificationManager />
        <ThreadAutoRenamer />
        <ThreadRunRecovery />
        <ThreadSyncManager />
      </AgentInterface>
    </div>
  );
}
