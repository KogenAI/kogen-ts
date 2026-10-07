# xspec/1 adapter over the read-only Kogen Accounts and CredentialStore modules.
# All writes go under a fresh temporary HOME. OAuth, browser launches, and remote
# revocation are intentionally represented as profile updates, never invoked.
root = Path.expand("~/Areas/Kogen/careful-rebuild")
ebin_root = Path.join(root, "_build/dev/lib")

for app <- File.ls!(ebin_root) do
  ebin = Path.join([ebin_root, app, "ebin"])
  if File.dir?(ebin), do: Code.append_path(ebin)
end

defmodule Adapter do
  alias Kogen.Contracts.Project
  alias Kogen.Contracts.ProviderError
  alias Kogen.Kernel.Accounts
  alias Kogen.Provider.ChatGPT.CredentialStore

  @projects ["alpha", "bravo"]
  @refresh_tags ["Seed", "Login", "Logout", "Use", "ProviderDefault", "Corrupt", "ListAccounts"]

  def init do
    old = System.get_env("HOME")
    sandbox = Path.join(System.tmp_dir!(), "xspec-accounts-#{System.unique_integer([:positive])}")
    File.rm_rf!(sandbox)
    home = Path.join(sandbox, "home")
    File.mkdir_p!(home)
    System.put_env("HOME", home)
    projects = Map.new(@projects, fn name -> {name, Path.join(sandbox, "projects/#{name}")} end)
    File.mkdir_p!(Path.join(sandbox, "projects"))

    state = %{sandbox: sandbox, home: home, root: Path.join(home, ".kogen"), projects: projects,
      project_info: %{}, env_provider: "", env_account: "", resolved_project: "",
      resolved_provider: "", resolved_label: "", resolved_saved: false,
      last: "ok", exit: 0, operation: "none", original_home: old,
      actual: %{"chatDefault" => "default", "chatAlpha" => "", "chatBravo" => "",
        "grokDefault" => "default", "grokAlpha" => "", "grokBravo" => "",
        "selectedDefault" => "chatgpt", "providerAlpha" => "", "providerBravo" => "",
        "rows" => [%{"provider" => "chatgpt", "label" => "", "isDefault" => false,
          "signedIn" => false, "email" => "", "expires" => 0}], "broken" => false}}
    refresh_actual(state)
  end

  def handle(%{"op" => "reset"}, state) do
    if state, do: File.rm_rf(state.sandbox)
    init()
  end

  def handle(%{"op" => "apply", "event" => %{"tag" => tag} = event}, state) do
    state = apply_event(tag, event["value"], state)
    if tag in @refresh_tags, do: refresh_actual(state), else: state
  end

  def handle(_, state), do: %{state | last: "bad_event", exit: 2}

  def observe(state) do
    Map.merge(state.actual, %{
      "last" => state.last,
      "exit" => state.exit,
      "operation" => state.operation,
      "resolvedProvider" => state.resolved_provider,
      "resolvedLabel" => state.resolved_label,
      "resolvedSaved" => state.resolved_saved
    })
  end

  defp apply_event("Init", _, state), do: reset_state(state)

  defp apply_event("Seed", %{"provider" => "chatgpt", "label" => label} = p, state) do
    result = if p["present"], do: put_profile(state, label, p), else: :ok
    result_state(state, result, "seed")
  end

  defp apply_event("Seed", _, state), do: result_state(state, {:unsupported, :provider}, "seed")

  defp apply_event("Login", %{"provider" => "chatgpt", "success" => true} = p, state) do
    result = put_profile(state, "default", %{
      "signedIn" => true, "email" => p["email"], "expires" => p["expires"],
      "hasExpiry" => p["hasExpiry"], "notice" => p["notice"], "remoteRevoked" => false
    })
    result_state(state, result, if(p["notice"], do: "login_notice", else: "login"))
  end

  defp apply_event("Login", %{"provider" => "chatgpt", "success" => false}, state),
    do: result_state(state, :ok, "login") |> Map.merge(%{last: "login_failed", exit: 4})

  defp apply_event("Login", _, state), do: result_state(state, {:unsupported, :provider}, "login")

  defp apply_event("Logout", %{"provider" => "chatgpt"} = e, state) do
    result =
      with :ok <- CredentialStore.delete(state.root, :file, "default"),
           :ok <- CredentialStore.update_profile(state.root, "default", %{
             signed_in: false, remote_revoked: e["remote"] == true
           }) do
        :ok
      end

    result_state(state, result, if(e["remote"], do: "logout_remote", else: "logout_local"))
  end

  defp apply_event("Logout", %{"provider" => "grok"}, state),
    do: result_state(state, {:unsupported, :provider}, "logout_local")

  defp apply_event("Logout", _, state), do: result_state(state, {:unsupported, :provider}, "logout")

  defp apply_event("Use", %{"provider" => provider, "label" => label}, state) when provider != "chatgpt" do
    case Kogen.Cli.Arguments.parse(["provider", "use", provider, "--as", label]) do
      {:error, {:usage, _, _}} -> %{state | last: "unknown_provider", exit: 2, operation: "use"}
      _ -> result_state(state, {:unsupported, :provider}, "use")
    end
  end

  defp apply_event("Use", %{"provider" => "chatgpt", "label" => label} = e, state) do
    target = if e["project"] == "", do: nil, else: project_path(state, e["project"])
    argv = ["provider", "use", "chatgpt", "--as", label] ++ if(target, do: ["--project", target], else: [])
    case Kogen.Cli.Arguments.parse(argv) do
      {:ok, args} ->
        if target do
          if e["projectExists"], do: File.mkdir_p!(target), else: File.rm_rf!(target)
        end
        result = Kogen.Kernel.provider_use(label, args.project)
        result_state(state, result, if(target, do: "use_project", else: "use_default"))
      {:error, {:usage, _, _}} ->
        %{state | last: "unsupported", exit: 2, operation: if(target, do: "use_project", else: "use_default")}
    end
  end

  defp apply_event("Use", _, state), do: result_state(state, {:unsupported, :event}, "use")

  defp apply_event("Project", %{"name" => name} = e, state) when name in @projects do
    path = project_path(state, name)
    if e["exists"], do: File.mkdir_p!(path), else: File.rm_rf!(path)
    info = %{exists: e["exists"], provider: e["provider"], account: e["account"]}
    %{state | project_info: Map.put(state.project_info, name, info), last: "ok", exit: 0, operation: "project"}
  end

  defp apply_event("Project", _, state), do: %{state | last: "unknown_project", exit: 2, operation: "project"}

  defp apply_event("ProviderDefault", %{"provider" => "chatgpt", "label" => label}, state) do
    result = if label == "", do: {:unsupported, :clear_default}, else: CredentialStore.put_account_choice(state.root, :default, label)
    result_state(state, result, "choice")
  end

  defp apply_event("ProviderDefault", _, state), do: result_state(state, {:unsupported, :provider}, "choice")

  defp apply_event("SelectionDefault", %{"provider" => "chatgpt"}, state),
    do: %{state | last: "ok", exit: 0, operation: "selection"}

  defp apply_event("SelectionDefault", _, state),
    do: %{state | last: "unsupported", exit: 2, operation: "selection"}

  defp apply_event("Environment", %{"provider" => provider, "account" => account}, state),
    do: %{state | env_provider: provider, env_account: account, last: "ok", exit: 0, operation: "environment"}

  defp apply_event("Corrupt", %{"broken" => true}, state) do
    File.mkdir_p!(state.root)
    File.write!(Path.join(state.root, "accounts.yaml"), "chatgpt:\n")
    %{state | last: "ok", exit: 0, operation: "accounts_file"}
  end

  defp apply_event("Corrupt", %{"broken" => false}, state) do
    File.rm(Path.join(state.root, "accounts.yaml"))
    %{state | last: "ok", exit: 0, operation: "accounts_file"}
  end

  defp apply_event("Resolve", %{"project" => project}, state) do
    result = resolve(state, project)
    case result do
      {:ok, label, saved} ->
        %{state | last: "ok", exit: 0, operation: "resolve", resolved_project: project,
          resolved_provider: "chatgpt", resolved_label: label, resolved_saved: saved}
      {:error, :invalid_accounts_file} ->
        %{state | last: "invalid_accounts_file", exit: 3, operation: "resolve"}
      {:error, _} ->
        %{state | last: "unsupported", exit: 70, operation: "resolve"}
    end
  end

  defp apply_event("ListAccounts", _, state) do
    result = Kogen.Kernel.provider_list()
    result_state(state, result, "list")
  end

  defp apply_event(_, _, state), do: %{state | last: "bad_event", exit: 2}

  defp reset_state(state) do
    File.rm_rf(state.sandbox)
    init()
  end

  defp put_profile(state, label, p) do
    attrs = %{
      signed_in: p["signedIn"] == true,
      remote_revoked: p["remoteRevoked"] == true,
      notice_shown: p["notice"] == true
    }
    with :ok <- CredentialStore.update_profile(state.root, label, attrs),
         {:ok, contents} <- File.read(Path.join(state.root, "profiles.json")),
         {:ok, all} <- Kogen.Contracts.JSON.decode(contents) do
      profiles = Map.get(all, "chatgpt", %{})
      profile = Map.get(profiles, label, %{})
      profile = optional(profile, "email", if(is_binary(p["email"]) and p["email"] != "", do: p["email"], else: nil))
      expiry = if p["hasExpiry"] and is_integer(p["expires"]) and p["expires"] > 0, do: p["expires"], else: nil
      profile = optional(profile, "expires_at", expiry)
      document = Map.put(all, "chatgpt", Map.put(profiles, label, profile))
      encoded = document |> :json.encode() |> IO.iodata_to_binary()
      Kogen.Provider.ChatGPT.FileStore.atomic_write(Path.join(state.root, "profiles.json"), encoded)
    end
  end

  defp optional(map, key, nil), do: Map.delete(map, key)
  defp optional(map, key, value), do: Map.put(map, key, value)

  defp result_state(state, {:unsupported, _}, operation),
    do: %{state | last: "unsupported", exit: 2, operation: operation}
  defp result_state(state, {:invalid_label}, operation),
    do: %{state | last: "invalid_label", exit: 2, operation: operation}
  defp result_state(state, {:unknown_project}, operation),
    do: %{state | last: "unknown_project", exit: 2, operation: operation}
  defp result_state(state, :ok, operation),
    do: %{state | last: "ok", exit: 0, operation: operation}
  defp result_state(state, {:ok, _}, operation),
    do: %{state | last: "ok", exit: 0, operation: operation}
  defp result_state(state, {:error, %ProviderError{class: :login}}, operation),
    do: %{state | last: "no_saved_login", exit: 4, operation: operation}
  defp result_state(state, {:error, {:invalid_accounts_file, _}}, operation),
    do: %{state | last: "invalid_accounts_file", exit: 3, operation: operation}
  defp result_state(state, {:error, _}, operation),
    do: %{state | last: "unsupported", exit: 70, operation: operation}
  defp result_state(state, _, operation),
    do: %{state | last: "unsupported", exit: 70, operation: operation}

  defp resolve(state, project) do
    info = Map.get(state.project_info, project, %{})
    path = if project in @projects, do: project_path(state, project), else: Path.join(state.sandbox, "no-project")
    File.mkdir_p!(path)
    project_struct = %Project{
      root: path, name: project, checks: [], setup: [], fix: [], diagnose: [],
      protected_paths: [], domains: %{}, account: Map.get(info, :account)
    }

    case Accounts.label(path, project_struct) do
      {:ok, label} ->
        profile = case CredentialStore.profile(state.root, label) do {:ok, p} -> p; _ -> nil end
        {:ok, label, profile != nil and profile.signed_in == true}
      {:error, {:invalid_accounts_file, _}} -> {:error, :invalid_accounts_file}
      {:error, _} -> {:error, :unsupported}
    end
  end

  defp choices(state) do
    case CredentialStore.account_choices(state.root) do
      {:ok, value} -> {value, false}
      _ -> {%{default: nil, projects: %{}}, true}
    end
  end

  defp refresh_actual(state) do
    {choices, broken} = choices(state)
    profiles = profiles(state)
    default = choices.default || "default"
    actual = %{
      "chatDefault" => default,
      "chatAlpha" => Map.get(choices.projects, project_path(state, "alpha"), ""),
      "chatBravo" => Map.get(choices.projects, project_path(state, "bravo"), ""),
      "grokDefault" => "default", "grokAlpha" => "", "grokBravo" => "",
      "selectedDefault" => "chatgpt", "providerAlpha" => "", "providerBravo" => "",
      "rows" => rows(profiles, default), "broken" => broken
    }
    %{state | actual: actual}
  end

  defp profiles(state) do
    case CredentialStore.profiles(state.root) do {:ok, value} -> value; _ -> [] end
  end

  defp rows([], _default), do: [%{"provider" => "chatgpt", "label" => "", "isDefault" => false, "signedIn" => false, "email" => "", "expires" => 0}]
  defp rows(profiles, default) do
    Enum.map(profiles, fn p -> %{
      "provider" => "chatgpt", "label" => p.label,
      "isDefault" => p.label == default, "signedIn" => p.signed_in,
      "email" => p.email || "", "expires" => p.expires_at || 0
    } end)
  end

  defp project_path(state, name), do: Kogen.Kernel.Workspaces.canonical(Map.fetch!(state.projects, name))

  def loop(state) do
    case IO.binread(:stdio, :line) do
      :eof -> File.rm_rf(state.sandbox); :ok
      {:error, _} -> File.rm_rf(state.sandbox); :ok
      line ->
        state = handle(JSON.decode!(String.trim(line)), state)
        IO.binwrite(:stdio, [JSON.encode!(observe(state)), "\n"])
        loop(state)
    end
  end
end

Adapter.loop(Adapter.init())
