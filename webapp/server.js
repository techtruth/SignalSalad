const webpack = require("webpack");
const path = require("path");
const fs = require("fs");
const os = require("os");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const argv = require("minimist")(process.argv.slice(2));

const devtoolsWorkspaceRoot = path.resolve(__dirname);
const DEVTOOLS_WORKSPACE_UUID = "6d3dd03f-253f-4b70-aa46-9bf00f100000";
const DEVTOOLS_DESCRIPTOR_DIR = path.resolve(
  process.env.DEVTOOLS_DESCRIPTOR_DIR ||
    path.resolve(os.tmpdir(), "signalsalad-webapp/.well-known/appspecific"),
);

const writeDevtoolsWorkspaceDescriptor = () => {
  const descriptorDir = DEVTOOLS_DESCRIPTOR_DIR;
  const descriptorPath = path.resolve(
    descriptorDir,
    "com.chrome.devtools.json",
  );
  fs.mkdirSync(descriptorDir, { recursive: true });
  fs.writeFileSync(
    descriptorPath,
    JSON.stringify(
      {
        workspace: {
          root: devtoolsWorkspaceRoot,
          uuid: DEVTOOLS_WORKSPACE_UUID,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
};

const config = {
  context: __dirname,
  mode: argv.mode === "production" ? "production" : "development",
  bail: true,
  devtool: argv.mode === "development" ? "eval-source-map" : false,

  entry: {
    app: ["./index.js"],
  },

  resolve: {
    extensions: [".ts", ".js"],
  },

  output: {
    path: path.resolve(__dirname, "dist"),
    publicPath: "/",
    filename: "js/[chunkhash].js",
    sourceMapFilename: "js/[contenthash].js.map[query]",
    chunkFilename: "js/bundle.[contenthash].js",
    assetModuleFilename: "assets/[name]-[contenthash][ext]",
    hashFunction: "xxhash64",
  },

  plugins: [
    new HtmlWebpackPlugin({
      title: process.env.npm_package_version,
      filename: "index.html",
    }),
    new MiniCssExtractPlugin({ filename: "[name]-[contenthash].css" }),
  ],

  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: "ts-loader",
        options: {
          transpileOnly: true,
        },
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, "css-loader"],
      },
      {
        test: /\.png$|\.jpg$|\.svg$/,
        type: "asset",
      },
    ],
  },
};

if (!argv.watch) {
  console.log("Compiling webpack...");
  webpack(config, (err, stats) => {
    if (err) {
      console.error("Webpack Error:");
      console.log(err);
      throw new Error("Webpack build failed");
    }
    if (stats.hasErrors() || stats.hasWarnings()) {
      console.log(stats.toString({ colors: true }));
      return;
    }
    writeDevtoolsWorkspaceDescriptor();
    console.log(
      stats.toString({
        colors: true,
        warnings: true,
        assets: true,
        moduleAssets: true,
        groupAssetsByChunk: false,
        groupAssetsByEmitStatus: false,
        groupAssetsByInfo: false,
        orphanModules: true,
        modules: true,
        groupModulesByAttributes: false,
        dependentModules: true,
        entrypoints: true,
        chunks: false,
        chunkGroups: false,
        chunkModules: false,
        chunkOrigins: false,
        chunkRelations: false,
        env: true,
        performance: true,
      }),
    );
  });
} else {
  console.log("Compiling webpack and watching for changes...");
  webpack(config).watch(
    {
      aggregateTimeout: 500,
      poll: 2000,
      ignored: /node_modules/,
    },
    (err, stats) => {
      if (err) {
        console.error(err);
        return;
      }
      if (stats && stats.hasErrors()) {
        console.error(stats.toString({ colors: true }));
        return;
      }
      writeDevtoolsWorkspaceDescriptor();
      console.log(stats.toString({ colors: true }));
    },
  );
}
