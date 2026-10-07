# Replays the lock half of the queue slice against Kogen.Queue.Lock.
# The drain's serial loop is not a pure function. Outcome steps report line "not_replayed"
# and the harness records that miss. Lock acquire, a dead pid, and queue stop are real.
root = Path.join(System.tmp_dir!(), "kogen-quint-queue-#{System.pid()}")
File.rm_rf!(root)
File.mkdir_p!(root)

Code.ensure_loaded!(Kogen.Queue.Lock)

defmodule Adapter do
  def blank(extra) do
    Map.merge(
      %{
        "last" => "ok",
        "line" => "",
        "exit" => 0,
        "held" => false,
        "alive" => false,
        "stop" => false,
        "phase" => "idle",
        "current" => "",
        "queue" => [],
        "built" => 0,
        "landed" => 0
      },
      extra
    )
  end

  def observe(root) do
    stop = Kogen.Queue.Lock.stop_requested?(root)

    case Kogen.Queue.Lock.state(root) do
      {:running, _pid} ->
        blank(%{"held" => true, "alive" => true, "stop" => stop, "line" => "lock"})

      :stopped ->
        blank(%{"held" => false, "alive" => false, "stop" => stop, "line" => "lock"})

      {:error, reason} ->
        blank(%{"last" => "lock_error", "line" => inspect(reason)})
    end
  end

  def handle(%{"op" => "reset"}, root) do
    File.rm_rf!(root)
    File.mkdir_p!(root)
    root
  end

  def handle(%{"op" => "apply", "event" => %{"tag" => "Start"}}, root) do
    _ = Kogen.Queue.Lock.acquire(root)
    root
  end

  def handle(%{"op" => "apply", "event" => %{"tag" => "Die"}}, root) do
    pid_path = Path.join(root, "queue.pid")
    File.mkdir_p!(root)
    File.write!(pid_path, "999999\n")
    root
  end

  def handle(%{"op" => "apply", "event" => %{"tag" => "Halt"}}, root) do
    _ = Kogen.Queue.Lock.request_stop(root)
    root
  end

  def handle(%{"op" => "apply", "event" => %{"tag" => "Release"}}, root) do
    _ = Kogen.Queue.Lock.release(root)
    root
  end

  def handle(_other, root), do: root

  def loop(root) do
    case IO.binread(:stdio, :line) do
      :eof ->
        :ok

      {:error, _} ->
        :ok

      line ->
        root = handle(JSON.decode!(String.trim(line)), root)
        IO.binwrite(:stdio, [JSON.encode!(observe(root)), "\n"])
        loop(root)
    end
  end
end

Adapter.loop(root)
