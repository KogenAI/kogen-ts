defmodule GreetTest do
  use ExUnit.Case

  @tag intent: "greet/A1"
  test "greets Almir" do
    assert Hello.greet() == "Hello, Almir!"
  end
end
