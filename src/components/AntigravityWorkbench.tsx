"use client";

import "@openuidev/react-ui/styles/index.css";

import { AntigravityAssistantMessage } from "@/components/AntigravityAssistantMessage";
import { AntigravityComposer } from "@/components/AntigravityComposer";
import { AntigravityUserMessage } from "@/components/AntigravityUserMessage";
import { AntigravityDialogs } from "@/components/Dialogs";
import { FolderSidebar } from "@/components/FolderSidebar";
import { ThreadAutoRenamer } from "@/components/ThreadAutoRenamer";
import { ThreadRunRecovery } from "@/components/ThreadRunRecovery";
import { ThreadSyncManager } from "@/components/ThreadSyncManager";
import { acpStore } from "@/lib/client/acp-store";
import { createAntigravityChatBindings } from "@/lib/client/local-storage";
import { useThread } from "@openuidev/react-headless";
import { AgentInterface, useThemeModePreference } from "@openuidev/react-ui";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { BarChart3, GitBranch, ListChecks, Sparkles } from "lucide-react";
import { useEffect, useMemo } from "react";

const STARTERS = [
  {
    displayText: "Workspace Dashboard",
    icon: BarChart3,
    prompt:
      "Inspect this workspace and present a rich dashboard with KPI cards, a table of files/dependencies, and a chart breaking down file types or dependency counts.",
  },
  {
    displayText: "Git & Repo Health",
    icon: GitBranch,
    prompt:
      "Run git status and recent git log, then render a repository health dashboard with a table of recent commits and a visual summary.",
  },
  {
    displayText: "Interactive Config Form",
    icon: ListChecks,
    prompt:
      "Create an interactive setup form using OptionCards, Select, Slider, and TextArea to help me configure a new project workflow, and summarize my choices when I submit.",
  },
  {
    displayText: "Use /antigravity-guide",
    icon: Sparkles,
    prompt:
      "/antigravity-guide Summarize Antigravity CLI slash commands, skills, and MCP configuration in a comparison table and steps card.",
  },
];

function WelcomeHero() {
  const processMessage = useThread((s) => s.processMessage);
  const isRunning = useThread((s) => s.isRunning);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center justify-center px-6 py-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        Antigravity Generative UI
      </h1>
      <p className="mt-2 max-w-xl text-sm opacity-75">
        Powered by <span className="font-mono">agy acp</span> and OpenUI. Every reply renders as
        live charts, forms, tables, and dashboards—with full slash command, skill, and MCP parity.
      </p>
      <div className="mt-6 grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2">
        {STARTERS.map((starter) => {
          const Icon = starter.icon;
          return (
            <button
              key={starter.displayText}
              type="button"
              disabled={isRunning}
              onClick={() => void processMessage({ role: "user", content: starter.prompt })}
              className="flex min-h-[44px] items-center gap-2.5 rounded-xl border border-black/10 dark:border-white/15 bg-black/[0.02] dark:bg-white/[0.03] px-3.5 py-2.5 text-left text-xs transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
            >
              <Icon className="h-4 w-4 shrink-0 opacity-75" aria-hidden="true" />
              <span className="font-medium">{starter.displayText}</span>
            </button>
          );
        })}
      </div>
    </div>
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
    <div className="h-dvh w-screen overflow-hidden">
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
            <div className="flex w-full items-center justify-between border-t border-black/[0.06] dark:border-white/[0.08] px-1.5 pt-2">
              <span className="text-[11px] font-medium opacity-45">Antigravity</span>
              <AgentInterface.ThemeModeToggle mode={mode} onModeChange={setPreference} />
            </div>
          </AgentInterface.SidebarFooter>
        </AgentInterface.Sidebar>

        <AgentInterface.ThreadHeader
          className="!hidden"
          showChatTitle={false}
          showChatActions={false}
        />

        <AgentInterface.Welcome>
          <WelcomeHero />
        </AgentInterface.Welcome>

        <AgentInterface.Composer>
          <AntigravityComposer />
        </AgentInterface.Composer>

        <AntigravityDialogs />
        <ThreadAutoRenamer />
        <ThreadRunRecovery />
        <ThreadSyncManager />
      </AgentInterface>
    </div>
  );
}
